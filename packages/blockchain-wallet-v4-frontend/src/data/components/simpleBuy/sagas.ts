import BigNumber from 'bignumber.js'
import { getQuote } from 'blockchain-wallet-v4-frontend/src/modals/SimpleBuy/EnterAmount/Checkout/validation'
import moment from 'moment'
import { defaultTo, filter, prop } from 'ramda'
import { call, cancel, delay, fork, put, race, retry, select, take } from 'redux-saga/effects'

import { Remote } from '@core'
import { APIType } from '@core/network/api'
import {
  Everypay3DSResponseType,
  FiatEligibleType,
  FiatType,
  OrderType,
  ProductTypes,
  ProviderDetailsType,
  SBAccountType,
  SBCardStateType,
  SBCardType,
  SBOrderType,
  SBPaymentTypes,
  SBQuoteType,
  SwapOrderType,
  WalletFiatType,
  WalletOptionsType
} from '@core/types'
import { errorHandler, errorHandlerCode } from '@core/utils'
import { actions, selectors } from 'data'
import { generateProvisionalPaymentAmount } from 'data/coins/utils'
import {
  AddBankStepType,
  BankPartners,
  BankTransferAccountType,
  BrokerageModalOriginType,
  UserDataType
} from 'data/types'

import profileSagas from '../../modules/profile/sagas'
import brokerageSagas from '../brokerage/sagas'
import { convertBaseToStandard, convertStandardToBase } from '../exchange/services'
import sendSagas from '../send/sagas'
import { FALLBACK_DELAY, getOutputFromPair } from '../swap/model'
import swapSagas from '../swap/sagas'
import { SwapBaseCounterTypes } from '../swap/types'
import { getRate, NO_QUOTE } from '../swap/utils'
import { selectReceiveAddress } from '../utils/sagas'
import {
  DEFAULT_SB_BALANCES,
  DEFAULT_SB_METHODS,
  getCoinFromPair,
  getFiatFromPair,
  getNextCardExists,
  NO_ACCOUNT,
  NO_CHECKOUT_VALS,
  NO_FIAT_CURRENCY,
  NO_ORDER_EXISTS,
  NO_PAIR_SELECTED,
  NO_PAYMENT_TYPE,
  POLLING,
  SDD_TIER
} from './model'
import * as S from './selectors'
import { actions as A } from './slice'
import * as T from './types'
import { getDirection } from './utils'

export const logLocation = 'components/simpleBuy/sagas'

export default ({ api, coreSagas, networks }: { api: APIType; coreSagas: any; networks: any }) => {
  const { createUser, isTier2, waitForUserData } = profileSagas({
    api,
    coreSagas,
    networks
  })
  const { buildAndPublishPayment, paymentGetOrElse } = sendSagas({
    api,
    coreSagas,
    networks
  })
  const { calculateProvisionalPayment } = swapSagas({
    api,
    coreSagas,
    networks
  })
  const { fetchBankTransferAccounts } = brokerageSagas({ api })

  const activateSBCard = function* ({ payload }: ReturnType<typeof A.activateCard>) {
    let providerDetails: ProviderDetailsType
    try {
      yield put(A.activateCardLoading())
      const domainsR = selectors.core.walletOptions.getDomains(yield select())
      const domains = domainsR.getOrElse({
        walletHelper: 'https://wallet-helper.blockchain.com'
      } as WalletOptionsType['domains'])
      if (payload.partner === 'EVERYPAY') {
        providerDetails = yield call(
          api.activateSBCard,
          payload.id,
          `${domains.walletHelper}/wallet-helper/everypay/#/response-handler`
        )
        yield put(A.activateCardSuccess(providerDetails))
      } else {
        throw new Error('UNKNOWN_PARTNER')
      }
    } catch (e) {
      const error = errorHandler(e)
      yield put(A.activateCardFailure(error))
    }
  }

  const fetchSBCardSDD = function* (billingAddress: T.SBBillingAddressFormValuesType) {
    let card: SBCardType
    try {
      yield put(A.fetchCardLoading())
      const state = yield select()
      let currency = selectors.core.settings.getCurrency(state).getOrElse('USD')
      const origin = S.getOrigin(state)
      if (origin !== 'SettingsGeneral') {
        const order = S.getSBLatestPendingOrder(state)
        if (!order) throw new Error(NO_ORDER_EXISTS)
        currency = getFiatFromPair(order.pair)
        if (!currency) throw new Error(NO_FIAT_CURRENCY)
      }

      const userDataR = selectors.modules.profile.getUserData(state)
      const userData = userDataR.getOrFail('NO_USER_ADDRESS')

      if (!billingAddress) throw new Error('NO_USER_ADDRESS')

      card = yield call(
        api.createSBCard,
        currency,
        {
          ...billingAddress
        },
        userData.email
      )
      yield put(A.fetchCardSuccess(card))
    } catch (e) {
      const error = errorHandler(e)
      yield put(A.fetchCardFailure(error))
    }
  }

  const addCardDetails = function* () {
    try {
      const formValues: T.SBAddCardFormValuesType = yield select(
        selectors.form.getFormValues('addCCForm')
      )
      const existingCardsR = S.getSBCards(yield select())
      const existingCards = existingCardsR.getOrElse([] as Array<SBCardType>)
      const nextCardAlreadyExists = getNextCardExists(existingCards, formValues)

      if (nextCardAlreadyExists) throw new Error('CARD_ALREADY_SAVED')

      yield put(
        A.setStep({
          step: '3DS_HANDLER'
        })
      )
      yield put(A.addCardLoading())

      let waitForAction = true
      // Create card
      if (formValues.billingaddress && !formValues.sameAsBillingAddress) {
        yield call(fetchSBCardSDD, formValues.billingaddress)
        waitForAction = false
      } else {
        yield put(A.fetchCard())
      }
      if (waitForAction) {
        yield take([A.fetchCardSuccess.type, A.fetchCardFailure.type])
      }
      const cardR = S.getSBCard(yield select())
      const card = cardR.getOrFail('CARD_CREATION_FAILED')

      // Activate card
      yield put(A.activateCard(card))
      yield take([A.activateCardSuccess.type, A.activateCardFailure.type])

      const providerDetailsR = S.getSBProviderDetails(yield select())
      const providerDetails = providerDetailsR.getOrFail('CARD_ACTIVATION_FAILED')
      const [nonce] = yield call(api.generateUUIDs, 1)

      const response: { data: Everypay3DSResponseType } = yield call(
        // @ts-ignore
        api.submitSBCardDetailsToEverypay,
        {
          accessToken: providerDetails.everypay.mobileToken,
          apiUserName: providerDetails.everypay.apiUsername,
          ccNumber: formValues['card-number'].replace(/[^\d]/g, ''),
          cvc: formValues.cvc,
          expirationDate: moment(formValues['expiry-date'], 'MM/YY'),
          holderName: formValues['name-on-card'],
          nonce
        }
      )
      yield put(A.addCardSuccess(response.data))
    } catch (e) {
      const error = errorHandler(e)
      yield put(
        A.setStep({
          step: 'ADD_CARD'
        })
      )
      yield put(actions.form.startSubmit('addCCForm'))
      yield put(
        actions.form.stopSubmit('addCCForm', {
          _error: error as T.SBAddCardErrorType
        })
      )
      yield put(A.addCardFailure(error))
    }
  }

  const addCardFinished = function* () {
    // This is primarily used in general settings to short circuit
    // the SB flow when adding a new card but not buying crypto
    yield take(A.fetchCardsSuccess.type)
    yield put(actions.modals.closeAllModals())
  }

  const cancelSBOrder = function* ({ payload }: ReturnType<typeof A.cancelOrder>) {
    try {
      const { state } = payload
      const fiatCurrency = getFiatFromPair(payload.pair)
      const cryptoCurrency = getCoinFromPair(payload.pair)
      yield put(actions.form.startSubmit('cancelSBOrderForm'))
      yield call(api.cancelSBOrder, payload)
      yield put(actions.form.stopSubmit('cancelSBOrderForm'))
      yield put(A.fetchOrders())
      if (state === 'PENDING_CONFIRMATION' && fiatCurrency && cryptoCurrency) {
        const pair = S.getSBPair(yield select())
        const method = S.getSBPaymentMethod(yield select())
        if (pair) {
          yield put(
            A.setStep({
              cryptoCurrency,
              fiatCurrency,
              method,
              orderType: payload.side || OrderType.BUY,
              pair,
              step: 'ENTER_AMOUNT'
            })
          )
        } else {
          yield put(
            A.setStep({
              fiatCurrency,
              step: 'CRYPTO_SELECTION'
            })
          )
        }
      } else {
        yield put(actions.modals.closeAllModals())
      }
    } catch (e) {
      const error = errorHandler(e)
      yield put(actions.form.stopSubmit('cancelSBOrderForm', { _error: error }))
    }
  }

  const createSBOrder = function* ({ payload }: ReturnType<typeof A.createOrder>) {
    const { paymentMethodId, paymentType } = payload
    const values: T.SBCheckoutFormValuesType = yield select(
      selectors.form.getFormValues('simpleBuyCheckout')
    )
    try {
      const pair = S.getSBPair(yield select())
      if (!values) throw new Error(NO_CHECKOUT_VALS)
      if (!pair) throw new Error(NO_PAIR_SELECTED)
      const { fix, orderType, period } = values

      // since two screens use this order creation saga and they have different
      // forms, detect the order type and set correct form to submitting
      if (orderType === OrderType.SELL) {
        yield put(actions.form.startSubmit('previewSell'))
      } else {
        yield put(actions.form.startSubmit('simpleBuyCheckout'))
      }

      const fiat = getFiatFromPair(pair.pair)
      const coin = getCoinFromPair(pair.pair)
      const amount =
        fix === 'FIAT'
          ? convertStandardToBase('FIAT', values.amount)
          : convertStandardToBase(coin, values.amount)
      const inputCurrency = orderType === OrderType.BUY ? fiat : coin
      const outputCurrency = orderType === OrderType.BUY ? coin : fiat
      const input = { amount, symbol: inputCurrency }
      const output = { amount, symbol: outputCurrency }

      // used for sell only now, eventually buy as well
      // TODO: use swap2 quote for buy AND sell
      if (orderType === OrderType.SELL) {
        const from = S.getSwapAccount(yield select())
        const quote = S.getSellQuote(yield select()).getOrFail(NO_QUOTE)
        if (!from) throw new Error(NO_ACCOUNT)

        const direction = getDirection(from)
        const cryptoAmt =
          fix === 'CRYPTO'
            ? amount
            : convertStandardToBase(
                from.coin,
                getQuote(pair.pair, convertStandardToBase('FIAT', quote.rate), fix, amount)
              )
        const refundAddr =
          direction === 'FROM_USERKEY'
            ? yield call(selectReceiveAddress, from, networks)
            : undefined
        const sellOrder: SwapOrderType = yield call(
          api.createSwapOrder,
          direction,
          quote.quote.id,
          cryptoAmt,
          getFiatFromPair(pair.pair),
          undefined,
          refundAddr
        )
        // on chain
        if (direction === 'FROM_USERKEY') {
          const paymentR = S.getPayment(yield select())
          // @ts-ignore
          const payment = paymentGetOrElse(from.coin, paymentR)
          try {
            yield call(buildAndPublishPayment, payment.coin, payment, sellOrder.kind.depositAddress)
            yield call(api.updateSwapOrder, sellOrder.id, 'DEPOSIT_SENT')
          } catch (e) {
            yield call(api.updateSwapOrder, sellOrder.id, 'CANCEL')
            throw e
          }
        }
        yield put(
          A.setStep({
            sellOrder,
            step: 'SELL_ORDER_SUMMARY'
          })
        )
        yield put(actions.form.stopSubmit('previewSell'))
        yield put(actions.components.refresh.refreshClicked())
        return yield put(actions.components.swap.fetchTrades())
      }

      if (!paymentType) throw new Error(NO_PAYMENT_TYPE)

      if (orderType === OrderType.BUY && fix === 'CRYPTO') {
        // @ts-ignore
        delete input.amount
      }
      if (orderType === OrderType.BUY && fix === 'FIAT') {
        // @ts-ignore
        delete output.amount
      }

      const buyOrder: SBOrderType = yield call(
        api.createSBOrder,
        pair.pair,
        orderType,
        true,
        input,
        output,
        paymentType,
        period,
        paymentMethodId
      )

      yield put(actions.form.stopSubmit('simpleBuyCheckout'))
      yield put(A.fetchOrders())
      yield put(A.setStep({ order: buyOrder, step: 'CHECKOUT_CONFIRM' }))
    } catch (e) {
      // After CC has been activated we try to create an order
      // If order creation fails go back to ENTER_AMOUNT step
      // Wait for the form to be INITIALIZED and display err
      const step = S.getStep(yield select())
      if (step !== 'ENTER_AMOUNT') {
        const pair = S.getSBPair(yield select())
        const method = S.getSBPaymentMethod(yield select())
        const from = S.getSwapAccount(yield select())
        // If user doesn't enter amount into checkout
        // they are redirected back to checkout screen
        // ensures newly linked bank account is fetched
        yield call(fetchBankTransferAccounts)
        if (pair) {
          yield put(
            A.setStep({
              cryptoCurrency: getCoinFromPair(pair.pair),
              fiatCurrency: getFiatFromPair(pair.pair),
              method,
              orderType: values?.orderType,
              pair,
              step: 'ENTER_AMOUNT',
              swapAccount: from
            })
          )
          yield take(A.initializeCheckout.type)
          yield delay(3000)
          yield put(actions.form.startSubmit('simpleBuyCheckout'))
        }
      }

      const error: number | string = errorHandlerCode(e)
      if (values?.orderType === OrderType.SELL) {
        yield put(actions.form.stopSubmit('previewSell', { _error: error }))
      }
      yield put(actions.form.stopSubmit('simpleBuyCheckout', { _error: error }))
    }
  }

  const AuthUrlCheck = function* (orderId) {
    const order: ReturnType<typeof api.getSBOrder> = yield call(api.getSBOrder, orderId)
    if (order.attributes?.authorisationUrl || order.state === 'FAILED') {
      return order
    }
    throw new Error('retrying to fetch for AuthUrl')
  }

  const OrderConfirmCheck = function* (orderId) {
    const order: ReturnType<typeof api.getSBOrder> = yield call(api.getSBOrder, orderId)

    if (order.state === 'FINISHED' || order.state === 'FAILED' || order.state === 'CANCELED') {
      return order
    }
    throw new Error('Order verification timed out. It will continue in the background.')
  }

  const confirmOrderPoll = function* ({ payload }: ReturnType<typeof A.confirmOrderPoll>) {
    const { RETRY_AMOUNT, SECONDS } = POLLING
    const confirmedOrder = yield retry(RETRY_AMOUNT, SECONDS * 1000, OrderConfirmCheck, payload.id)
    yield put(actions.form.stopSubmit('sbCheckoutConfirm'))
    yield put(A.setStep({ order: confirmedOrder, step: 'ORDER_SUMMARY' }))
    yield put(A.fetchOrders())
  }

  const confirmOrder = function* ({ payload }: ReturnType<typeof A.confirmOrder>) {
    const { order, paymentMethodId } = payload
    try {
      if (!order) throw new Error(NO_ORDER_EXISTS)
      yield put(actions.form.startSubmit('sbCheckoutConfirm'))
      const account = selectors.components.brokerage.getAccount(yield select())
      const domainsR = selectors.core.walletOptions.getDomains(yield select())
      const domains = domainsR.getOrElse({
        walletHelper: 'https://wallet-helper.blockchain.com',
        yapilyCallbackUrl: 'https://www.blockchain.com/brokerage-link-success'
      } as WalletOptionsType['domains'])

      let attributes
      if (
        order.paymentType === SBPaymentTypes.PAYMENT_CARD ||
        order.paymentType === SBPaymentTypes.USER_CARD
      ) {
        attributes =
          order.paymentMethodId || paymentMethodId
            ? {
                everypay: {
                  customerUrl: `${domains.walletHelper}/wallet-helper/everypay/#/response-handler`
                }
              }
            : undefined
      } else if (account?.partner === BankPartners.YAPILY) {
        attributes = { callback: domains.yapilyCallbackUrl }
      }

      const confirmedOrder: SBOrderType = yield call(
        api.confirmSBOrder,
        order,
        attributes,
        paymentMethodId
      )

      // Check if the user has a yapily account and if they're submitting a bank transfer order
      if (
        order.paymentType === SBPaymentTypes.BANK_TRANSFER &&
        account?.partner === BankPartners.YAPILY
      ) {
        const { RETRY_AMOUNT, SECONDS } = POLLING
        // for OB the authorisationUrl isn't in the initial response to confirm
        // order. We need to poll the order for it.
        yield put(A.setStep({ step: 'LOADING' }))
        const order = yield retry(RETRY_AMOUNT, SECONDS * 1000, AuthUrlCheck, confirmedOrder.id)
        // Refresh the tx list in the modal background
        yield put(A.fetchOrders())

        yield put(A.setStep({ order, step: 'OPEN_BANKING_CONNECT' }))
        // Now we need to poll for the order success
        return yield call(confirmOrderPoll, A.confirmOrderPoll(confirmedOrder))
      }

      // Refresh recurring buy list to check for new pending RBs for next step
      yield put(actions.components.recurringBuy.fetchRegisteredList())

      yield put(actions.form.stopSubmit('sbCheckoutConfirm'))

      if (order.paymentType === SBPaymentTypes.BANK_TRANSFER) {
        yield put(A.setStep({ order: confirmedOrder, step: 'ORDER_SUMMARY' }))
      } else {
        yield put(A.setStep({ order: confirmedOrder, step: '3DS_HANDLER' }))
      }
      yield put(A.fetchOrders())
    } catch (e) {
      const error = errorHandler(e)
      yield put(A.setStep({ order, step: 'CHECKOUT_CONFIRM' }))
      yield put(actions.form.startSubmit('sbCheckoutConfirm'))
      yield put(actions.form.stopSubmit('sbCheckoutConfirm', { _error: error }))
    }
  }

  const confirmSBFundsOrder = function* () {
    try {
      const order = S.getSBOrder(yield select())
      if (!order) throw new Error(NO_ORDER_EXISTS)
      yield put(actions.form.startSubmit('sbCheckoutConfirm'))
      const confirmedOrder: SBOrderType = yield call(api.confirmSBOrder, order as SBOrderType)
      yield put(actions.form.stopSubmit('sbCheckoutConfirm'))
      yield put(A.fetchOrders())
      yield put(A.setStep({ order: confirmedOrder, step: 'ORDER_SUMMARY' }))
    } catch (e) {
      const error = errorHandler(e)
      yield put(actions.form.stopSubmit('sbCheckoutConfirm', { _error: error }))
    }
  }

  // TODO: move to BROKERAGE
  const deleteSBCard = function* ({ payload }: ReturnType<typeof A.deleteCard>) {
    try {
      if (!payload) return
      yield put(actions.form.startSubmit('linkedCards'))
      yield call(api.deleteSavedAccount, payload, 'cards')
      yield put(A.fetchCards(true))
      yield take([A.fetchCardsSuccess.type, A.fetchCardsFailure.type])
      yield put(actions.form.stopSubmit('linkedCards'))
      yield put(actions.alerts.displaySuccess('Card removed.'))
    } catch (e) {
      const error = errorHandler(e)
      yield put(actions.form.stopSubmit('linkedCards', { _error: error }))
      yield put(actions.alerts.displayError('Error removing card.'))
    }
  }

  const fetchSBBalances = function* ({ payload }: ReturnType<typeof A.fetchBalance>) {
    const { currency, skipLoading } = payload
    try {
      if (!skipLoading) yield put(A.fetchBalanceLoading())
      const balances: ReturnType<typeof api.getSBBalances> = yield call(api.getSBBalances, currency)
      yield put(A.fetchBalanceSuccess(balances))
    } catch (e) {
      yield put(A.fetchBalanceSuccess(DEFAULT_SB_BALANCES))
    }
  }

  const fetchSBCard = function* () {
    let card: SBCardType
    try {
      yield put(A.fetchCardLoading())
      const currency = S.getFiatCurrency(yield select())
      if (!currency) throw new Error(NO_FIAT_CURRENCY)

      const userDataR = selectors.modules.profile.getUserData(yield select())
      const billingAddressForm: T.SBBillingAddressFormValuesType | undefined = yield select(
        selectors.form.getFormValues('ccBillingAddress')
      )

      const userData = userDataR.getOrFail('NO_USER_ADDRESS')
      const address = billingAddressForm || userData.address
      if (!address) throw new Error('NO_USER_ADDRESS')

      card = yield call(
        api.createSBCard,
        currency,
        {
          ...address
        },
        userData.email
      )
      yield put(A.fetchCardSuccess(card))
    } catch (e) {
      const error = errorHandler(e)
      yield put(A.fetchCardFailure(error))
    }
  }

  const fetchSDDVerified = function* () {
    try {
      const isSddVerified = S.getSddVerified(yield select()).getOrElse({
        verified: false
      })

      const userIdR = yield select(selectors.core.kvStore.userCredentials.getUserId)
      const userId = userIdR.getOrElse(null)
      if (!isSddVerified.verified && userId) {
        yield put(A.fetchSDDVerifiedLoading())
        const sddEligible = yield call(api.fetchSDDVerified)
        yield put(A.fetchSDDVerifiedSuccess(sddEligible))
      }
    } catch (e) {
      const error = errorHandler(e)
      yield put(A.fetchSDDVerifiedFailure(error))
    }
  }

  const fetchSBCards = function* ({ payload }: ReturnType<typeof A.fetchCards>) {
    try {
      yield call(waitForUserData)

      yield call(fetchSDDVerified)
      const isUserTier2 = yield call(isTier2)
      const sddVerified = S.isUserSddVerified(yield select()).getOrElse(false)
      const loadCards = isUserTier2 || sddVerified

      if (!loadCards) return yield put(A.fetchCardsSuccess([]))
      if (!payload) yield put(A.fetchCardsLoading())
      const cards = yield call(api.getSBCards)
      yield put(A.fetchCardsSuccess(cards))
    } catch (e) {
      const error = errorHandler(e)
      yield put(A.fetchCardsFailure(error))
    }
  }

  const fetchFiatEligible = function* ({ payload }: ReturnType<typeof A.fetchFiatEligible>) {
    try {
      let fiatEligible: FiatEligibleType
      yield put(A.fetchFiatEligibleLoading())
      // If user is not tier 2 fake eligible check to allow KYC
      if (!(yield call(isTier2))) {
        fiatEligible = {
          eligible: true,
          paymentAccountEligible: true,
          simpleBuyTradingEligible: true
        }
      } else {
        fiatEligible = yield call(api.getSBFiatEligible, payload)
      }
      yield put(A.fetchFiatEligibleSuccess(fiatEligible))
    } catch (e) {
      const error = errorHandler(e)
      yield put(A.fetchFiatEligibleFailure(error))
    }
  }

  const fetchSDDEligible = function* () {
    try {
      yield put(A.fetchSDDEligibleLoading())
      yield call(waitForUserData)
      // check if user is already tier 2
      if (!(yield call(isTier2))) {
        // user not tier 2, call for sdd eligibility
        const sddEligible = yield call(api.fetchSDDEligible)
        yield put(A.fetchSDDEligibleSuccess(sddEligible))
      } else {
        // user is already tier 2, manually set as ineligible
        yield put(
          A.fetchSDDEligibleSuccess({
            eligible: false,
            ineligibilityReason: 'KYC_TIER',
            tier: 2
          })
        )
      }
    } catch (e) {
      const error = errorHandler(e)
      yield put(A.fetchSDDEligibleFailure(error))
    }
  }

  const fetchSBOrders = function* ({ payload }: ReturnType<typeof A.fetchOrders>) {
    try {
      yield call(waitForUserData)
      if (!payload) yield put(A.fetchOrdersLoading())
      const orders = yield call(api.getSBOrders, {})
      yield put(A.fetchOrdersSuccess(orders))
      yield put(actions.components.brokerage.fetchBankTransferAccounts())
    } catch (e) {
      const error = errorHandler(e)
      if (!(yield call(isTier2))) return yield put(A.fetchOrdersSuccess([]))
      yield put(A.fetchOrdersFailure(error))
    }
  }

  const fetchSBPairs = function* ({ payload }: ReturnType<typeof A.fetchPairs>) {
    const { coin, currency } = payload
    try {
      yield put(A.fetchPairsLoading())
      const { pairs }: ReturnType<typeof api.getSBPairs> = yield call(api.getSBPairs, currency)
      const filteredPairs = pairs.filter((pair) => {
        return (
          window.coins[getCoinFromPair(pair.pair)] &&
          window.coins[getCoinFromPair(pair.pair)].coinfig.type.name !== 'FIAT'
        )
      })
      yield put(A.fetchPairsSuccess({ coin, pairs: filteredPairs }))
    } catch (e) {
      const error = errorHandler(e)
      yield put(A.fetchPairsFailure(error))
    }
  }

  const fetchPaymentAccount = function* () {
    try {
      yield put(A.fetchPaymentAccountLoading())
      const fiatCurrency = S.getFiatCurrency(yield select())
      if (!fiatCurrency) throw new Error(NO_FIAT_CURRENCY)
      const account: SBAccountType = yield call(api.getSBPaymentAccount, fiatCurrency)
      yield put(A.fetchPaymentAccountSuccess(account))
    } catch (e) {
      const error = errorHandler(e)
      yield put(A.fetchPaymentAccountFailure(error))
    }
  }

  const fetchPaymentMethods = function* ({ payload }: ReturnType<typeof A.fetchPaymentMethods>) {
    try {
      yield call(waitForUserData)
      const userData = selectors.modules.profile.getUserData(yield select()).getOrElse({
        state: 'NONE'
      } as UserDataType)
      // 🚨DO NOT create the user if no currency is passed
      if (userData.state === 'NONE' && !payload) {
        return yield put(A.fetchPaymentMethodsSuccess(DEFAULT_SB_METHODS))
      }

      // Only show Loading if not Success or 0 methods
      const sbMethodsR = S.getSBPaymentMethods(yield select())
      const sbMethods = sbMethodsR.getOrElse(DEFAULT_SB_METHODS)
      if (!Remote.Success.is(sbMethodsR) || !sbMethods.methods.length)
        yield put(A.fetchPaymentMethodsLoading())

      // 🚨Create the user if you have a currency
      yield call(createUser)

      // If no currency fallback to sb fiat currency or wallet
      const fallbackFiatCurrency =
        S.getFiatCurrency(yield select()) ||
        (yield select(selectors.core.settings.getCurrency)).getOrElse('USD')

      const userSDDTierR = S.getUserSddEligibleTier(yield select())
      if (!Remote.Success.is(userSDDTierR)) {
        yield call(fetchSDDEligible)
      }
      const state = yield select()
      const currentUserTier = selectors.modules.profile.getCurrentTier(state)
      const userSDDEligibleTier = S.getUserSddEligibleTier(state).getOrElse(1)
      // only fetch non-eligible payment methods if user is not tier 2
      const includeNonEligibleMethods = currentUserTier === 2
      // if user is SDD tier 3 eligible, fetch limits for tier 3
      // else let endpoint return default current tier limits for current tier of user
      const includeTierLimits = userSDDEligibleTier === SDD_TIER ? SDD_TIER : undefined

      let paymentMethods = yield call(
        api.getSBPaymentMethods,
        payload || fallbackFiatCurrency,
        includeNonEligibleMethods,
        includeTierLimits
      )

      // 🚨👋 temporarily remove ACH from user payment methods if they are not t2
      // t2 users who are invited to ACH beta will still get method since the API will
      // return that method if they are actually eligible
      if (currentUserTier !== 2) {
        paymentMethods = paymentMethods.filter(
          (method) => method.type !== SBPaymentTypes.BANK_TRANSFER
        )
      }
      yield put(
        A.fetchPaymentMethodsSuccess({
          currency: payload || fallbackFiatCurrency,
          methods: paymentMethods
        })
      )
    } catch (e) {
      const error = errorHandler(e)
      yield put(A.fetchPaymentMethodsFailure(error))
    }
  }

  const fetchSBQuote = function* ({ payload }: ReturnType<typeof A.fetchQuote>) {
    try {
      const { amount, orderType, pair } = payload
      yield put(A.fetchQuoteLoading())
      const quote: SBQuoteType = yield call(api.getSBQuote, pair, orderType, amount)
      yield put(A.fetchQuoteSuccess(quote))
    } catch (e) {
      const error = errorHandler(e)
      yield put(A.fetchQuoteFailure(error))
    }
  }

  // new sell quote fetch
  // Copied from swap and hopefully eventually
  // shared between the 2 UIs and 3 methods (buy, sell, swap)

  // used for sell only now, eventually buy as well
  // TODO: use swap2 quote for buy AND sell
  const fetchSellQuote = function* ({ payload }: ReturnType<typeof A.fetchSellQuote>) {
    while (true) {
      try {
        yield put(A.fetchSellQuoteLoading())

        const { pair } = payload
        const direction = getDirection(payload.account)
        const quote: ReturnType<typeof api.getSwapQuote> = yield call(
          api.getSwapQuote,
          pair,
          direction
        )
        const rate = getRate(
          quote.quote.priceTiers,
          getOutputFromPair(pair),
          new BigNumber(convertStandardToBase(payload.account.coin, 1)),
          true
        )

        yield put(A.fetchSellQuoteSuccess({ quote, rate }))
        const refresh = -moment().diff(quote.expiresAt)
        yield delay(refresh)
      } catch (e) {
        const error = errorHandler(e)
        yield put(A.fetchSellQuoteFailure(error))
        yield delay(FALLBACK_DELAY)
        yield put(A.startPollSellQuote(payload))
      }
    }
  }

  const formChanged = function* (action) {
    try {
      if (action.meta.form !== 'simpleBuyCheckout') return
      if (action.meta.field !== 'amount') return
      const formValues = selectors.form.getFormValues('simpleBuyCheckout')(
        yield select()
      ) as T.SBCheckoutFormValuesType
      const account = S.getSwapAccount(yield select())
      const pair = S.getSBPair(yield select())

      if (!formValues) return
      if (!account) return
      if (!pair) return

      const paymentR = S.getPayment(yield select())
      const quoteR = S.getSellQuote(yield select())
      const quote = quoteR.getOrFail(NO_QUOTE)

      const amt = getQuote(pair.pair, quote.rate, formValues.fix, formValues.amount)

      const cryptoAmt = formValues.fix === 'CRYPTO' ? formValues.amount : amt
      yield put(actions.form.change('simpleBuyCheckout', 'cryptoAmount', cryptoAmt))
      if (account.type === SwapBaseCounterTypes.CUSTODIAL) return
      // @ts-ignore
      let payment = paymentGetOrElse(account.coin, paymentR)
      const paymentAmount = generateProvisionalPaymentAmount(account.coin, Number(cryptoAmt))
      payment = yield payment.amount(paymentAmount)
      payment = yield payment.build()
      yield put(A.updatePaymentSuccess(payment.value()))
    } catch (e) {
      // eslint-disable-next-line
      console.log(e)
    }
  }

  const handleSBDepositFiatClick = function* ({
    payload
  }: ReturnType<typeof A.handleDepositFiatClick>) {
    const { coin } = payload

    yield call(waitForUserData)
    const isUserTier2 = yield call(isTier2)

    if (!isUserTier2) {
      yield put(A.showModal({ origin: 'EmptyFeed' }))
      yield put(
        A.setStep({
          step: 'KYC_REQUIRED'
        })
      )
    } else {
      yield put(A.showModal({ origin: 'EmptyFeed' }))

      // wait for modal
      yield delay(500)
      yield put(
        A.setStep({
          displayBack: false,
          fiatCurrency: coin as FiatType,
          step: 'BANK_WIRE_DETAILS'
        })
      )
    }
  }

  const handleBuyMaxAmountClick = function* ({
    payload
  }: ReturnType<typeof A.handleBuyMaxAmountClick>) {
    const { amount, coin } = payload
    const standardAmt = convertBaseToStandard(coin, amount)

    yield put(actions.form.change('simpleBuyCheckout', 'amount', standardAmt))
  }

  const handleBuyMinAmountClick = function* ({
    payload
  }: ReturnType<typeof A.handleBuyMinAmountClick>) {
    const { amount, coin } = payload
    const standardAmt = convertBaseToStandard(coin, amount)

    yield put(actions.form.change('simpleBuyCheckout', 'amount', standardAmt))
  }

  const handleSellMaxAmountClick = function* ({
    payload
  }: ReturnType<typeof A.handleSellMaxAmountClick>) {
    const { amount, coin } = payload
    const standardAmt = convertBaseToStandard(coin, amount)

    yield put(actions.form.change('simpleBuyCheckout', 'amount', standardAmt))
  }

  const handleSellMinAmountClick = function* ({
    payload
  }: ReturnType<typeof A.handleSellMinAmountClick>) {
    const { amount, coin } = payload
    const standardAmt = convertBaseToStandard(coin, amount)

    yield put(actions.form.change('simpleBuyCheckout', 'amount', standardAmt))
  }

  const handleSBMethodChange = function* ({ payload }: ReturnType<typeof A.handleMethodChange>) {
    const values: T.SBCheckoutFormValuesType = yield select(
      selectors.form.getFormValues('simpleBuyCheckout')
    )

    const { isFlow, method } = payload
    const cryptoCurrency = S.getCryptoCurrency(yield select()) || 'BTC'
    const originalFiatCurrency = S.getFiatCurrency(yield select())
    const fiatCurrency = method.currency || S.getFiatCurrency(yield select())
    const pair = S.getSBPair(yield select())
    const swapAccount = S.getSwapAccount(yield select())
    if (!pair) return NO_PAIR_SELECTED
    const isUserTier2 = yield call(isTier2)

    if (!isUserTier2) {
      switch (method.type) {
        // https://blockc.slack.com/archives/GT1JZ1ZN2/p1596546978351100?thread_ts=1596541628.345800&cid=GT1JZ1ZN2
        // REMOVE THIS WHEN BACKEND CAN HANDLE PENDING 'FUNDS' ORDERS
        // 👇--------------------------------------------------------
        case SBPaymentTypes.BANK_ACCOUNT:
        case SBPaymentTypes.USER_CARD:
          return yield put(
            A.setStep({
              step: 'KYC_REQUIRED'
            })
          )
        // REMOVE THIS WHEN BACKEND CAN HANDLE PENDING 'FUNDS' ORDERS
        // 👆--------------------------------------------------------
        case SBPaymentTypes.PAYMENT_CARD:
          // ADD THIS WHEN BACKEND CAN HANDLE PENDING 'FUNDS' ORDERS
          // 👇-----------------------------------------------------
          // const methodType =
          //   method.type === SBPaymentTypes.BANK_ACCOUNT ? SBPaymentTypes.FUNDS : method.type
          // return yield put(A.createSBOrder(undefined, methodType))
          // 👆------------------------------------------------------

          return yield put(A.createOrder({ paymentType: method.type }))
        default:
          return
      }
    }

    // User is Tier 2
    switch (method.type) {
      case SBPaymentTypes.BANK_ACCOUNT:
        return yield put(
          A.setStep({
            displayBack: true,
            fiatCurrency,
            step: 'BANK_WIRE_DETAILS'
          })
        )
      case SBPaymentTypes.LINK_BANK:
        yield put(
          actions.components.brokerage.showModal({
            isFlow,
            modalType: fiatCurrency === 'USD' ? 'ADD_BANK_YODLEE_MODAL' : 'ADD_BANK_YAPILY_MODAL',
            origin: BrokerageModalOriginType.ADD_BANK_BUY
          })
        )
        return yield put(
          actions.components.brokerage.setAddBankStep({
            addBankStep: AddBankStepType.ADD_BANK
          })
        )

      case SBPaymentTypes.PAYMENT_CARD:
        return yield put(
          A.setStep({
            step: 'ADD_CARD'
          })
        )
      default:
        yield put(
          A.setStep({
            cryptoCurrency,
            fiatCurrency,
            method,
            orderType: values?.orderType,
            pair,
            step: 'ENTER_AMOUNT',
            swapAccount
          })
        )
    }

    // Change wallet/sb fiatCurrency if necessary
    // and fetch new pairs w/ new fiatCurrency
    // and pass along cryptoCurrency for pair swap
    if (originalFiatCurrency !== fiatCurrency) {
      yield put(actions.modules.settings.updateCurrency(method.currency, true))
      yield put(A.fetchPairs({ coin: cryptoCurrency, currency: method.currency }))
    }
  }

  const initializeBillingAddress = function* () {
    yield call(waitForUserData)
    const userDataR = selectors.modules.profile.getUserData(yield select())
    const userData = userDataR.getOrElse({} as UserDataType)
    const address = userData
      ? userData.address
      : {
          city: '',
          country: 'GB',
          line1: '',
          line2: '',
          postCode: '',
          state: ''
        }

    yield put(
      actions.form.initialize('ccBillingAddress', {
        ...address
      })
    )
  }

  const initializeCheckout = function* ({ payload }: ReturnType<typeof A.initializeCheckout>) {
    const { account, amount, cryptoAmount, fix, orderType, period } = payload
    try {
      yield call(waitForUserData)
      const fiatCurrency = S.getFiatCurrency(yield select())
      if (!fiatCurrency) throw new Error(NO_FIAT_CURRENCY)
      const pair = S.getSBPair(yield select())
      if (!pair) throw new Error(NO_PAIR_SELECTED)
      // Fetch rates
      if (orderType === OrderType.BUY) {
        yield put(A.fetchQuote({ amount: '0', orderType, pair: pair.pair }))
        // used for sell only now, eventually buy as well
        // TODO: use swap2 quote for buy AND sell
      } else {
        if (!account) throw NO_ACCOUNT

        yield put(A.fetchSellQuote({ account, pair: pair.pair }))
        yield put(A.startPollSellQuote({ account, pair: pair.pair }))
        yield race({
          failure: take(A.fetchSellQuoteFailure.type),
          success: take(A.fetchSellQuoteSuccess.type)
        })
        const quote = S.getSellQuote(yield select()).getOrFail(NO_QUOTE)

        if (account.type === SwapBaseCounterTypes.ACCOUNT) {
          const formValues = selectors.form.getFormValues('simpleBuyCheckout')(
            yield select()
          ) as T.SBCheckoutFormValuesType
          const payment = yield call(
            calculateProvisionalPayment,
            account,
            quote.quote,
            formValues ? formValues.cryptoAmount : 0
          )
          yield put(A.updatePaymentSuccess(payment))
        } else {
          yield put(A.updatePaymentSuccess(undefined))
        }
      }

      // Recurring Buy Feature Flag
      const isRecurringBuy = selectors.core.walletOptions
        .getFeatureFlagRecurringBuys(yield select())
        .getOrElse(false) as boolean

      yield put(
        actions.form.initialize('simpleBuyCheckout', {
          amount,
          cryptoAmount,
          fix,
          orderType,
          period: isRecurringBuy ? period : undefined
        })
      )
    } catch (e) {
      const error = errorHandler(e)
      yield put(actions.logs.logErrorMessage(error))
    }
  }

  const pollSBCardErrorHandler = function* (state: SBCardStateType) {
    yield put(A.setStep({ step: 'ADD_CARD' }))
    yield put(actions.form.startSubmit('addCCForm'))

    let error
    switch (state) {
      case 'PENDING':
        error = 'PENDING_CARD_AFTER_POLL'
        break
      default:
        error = 'LINK_CARD_FAILED'
    }

    yield put(
      actions.form.stopSubmit('addCCForm', {
        _error: error
      })
    )
  }

  const pollSBBalances = function* () {
    const skipLoading = true

    yield put(A.fetchBalance({ skipLoading }))
  }

  const pollSBCard = function* ({ payload }: ReturnType<typeof A.pollCard>) {
    let retryAttempts = 0
    const maxRetryAttempts = 20

    let card: ReturnType<typeof api.getSBCard> = yield call(api.getSBCard, payload)
    let step = S.getStep(yield select())

    while (
      (card.state === 'CREATED' || card.state === 'PENDING') &&
      retryAttempts < maxRetryAttempts
    ) {
      card = yield call(api.getSBCard, payload)
      retryAttempts += 1
      step = S.getStep(yield select())
      if (step !== '3DS_HANDLER') {
        yield cancel()
      }
      yield delay(3000)
    }

    switch (card.state) {
      case 'BLOCKED':
        yield call(pollSBCardErrorHandler, card.state)
        return
      case 'ACTIVE':
        const skipLoading = true
        const order = S.getSBLatestPendingOrder(yield select())
        yield put(A.fetchCards(skipLoading))
        // If the order was already created
        if (order && order.state === 'PENDING_CONFIRMATION') {
          return yield put(A.confirmOrder({ order, paymentMethodId: card.id }))
        }
        return yield put(
          A.createOrder({ paymentMethodId: card.id, paymentType: SBPaymentTypes.PAYMENT_CARD })
        )
      default:
        yield call(pollSBCardErrorHandler, card.state)
    }
  }

  const pollSBOrder = function* ({ payload }: ReturnType<typeof A.pollOrder>) {
    let retryAttempts = 0
    const maxRetryAttempts = 20

    let order: ReturnType<typeof api.getSBOrder> = yield call(api.getSBOrder, payload)
    let step = S.getStep(yield select())

    while (order.state === 'PENDING_DEPOSIT' && retryAttempts < maxRetryAttempts) {
      order = yield call(api.getSBOrder, payload)
      step = S.getStep(yield select())
      retryAttempts += 1
      if (step !== '3DS_HANDLER') {
        yield cancel()
      }
      yield delay(3000)
    }

    yield put(A.setStep({ order, step: 'ORDER_SUMMARY' }))
  }

  const setStepChange = function* (action: ReturnType<typeof A.setStep>) {
    if (action.type === '@EVENT.SET_SB_STEP') {
      if (action.payload.step === 'ORDER_SUMMARY') {
        yield call(pollSBBalances)
      }
    }
  }

  // Util function to help match payment method ID
  // to more details about the bank
  const getBankInformation = function* (order: SBOrderType) {
    yield put(actions.components.brokerage.fetchBankTransferAccounts())
    yield take(actions.components.brokerage.fetchBankTransferAccountsSuccess.type)
    const bankAccountsR = selectors.components.brokerage.getBankTransferAccounts(yield select())
    const bankAccounts = bankAccountsR.getOrElse([])
    const [bankAccount] = filter(
      (b: BankTransferAccountType) =>
        // @ts-ignore
        b.id === prop('paymentMethodId', order),
      defaultTo([])(bankAccounts)
    )

    return bankAccount
  }

  const showModal = function* ({ payload }: ReturnType<typeof A.showModal>) {
    const { cryptoCurrency, orderType, origin } = payload
    const latestPendingOrder = S.getSBLatestPendingOrder(yield select())

    yield put(actions.modals.showModal('SIMPLE_BUY_MODAL', { cryptoCurrency, origin }))
    const fiatCurrency = selectors.core.settings
      .getCurrency(yield select())
      .getOrElse('USD') as WalletFiatType

    if (latestPendingOrder) {
      const bankAccount = yield call(getBankInformation, latestPendingOrder as SBOrderType)
      let step: T.StepActionsPayload['step'] =
        latestPendingOrder.state === 'PENDING_CONFIRMATION' ? 'CHECKOUT_CONFIRM' : 'ORDER_SUMMARY'

      // When user closes the QR code modal and opens it via one of the pending
      // buy buttons in the app. We need to take them to the qrcode screen and
      // poll for the order status
      if (
        latestPendingOrder.state === 'PENDING_DEPOSIT' &&
        prop('partner', bankAccount) === BankPartners.YAPILY
      ) {
        step = 'OPEN_BANKING_CONNECT'
        yield fork(confirmOrderPoll, A.confirmOrderPoll(latestPendingOrder))
      }

      yield put(
        A.setStep({
          order: latestPendingOrder,
          step
        })
      )
    } else if (cryptoCurrency) {
      switch (orderType) {
        case OrderType.BUY:
          yield put(
            // 🚨 SPECIAL TS-IGNORE
            // Usually ENTER_AMOUNT should require a pair but
            // here we do not require a pair. Instead we have
            // cryptoCurrency and fiatCurrency and
            // INITIALIZE_CHECKOUT will set the pair on state.
            // 🚨 SPECIAL TS-IGNORE
            // @ts-ignore
            A.setStep({
              cryptoCurrency,
              fiatCurrency,
              orderType,
              step: 'ENTER_AMOUNT'
            })
          )
          break
        case OrderType.SELL:
          yield put(
            A.setStep({
              cryptoCurrency,
              fiatCurrency,
              orderType,
              step: 'CRYPTO_SELECTION'
            })
          )
          break
        default:
          // do nothing
          break
      }
    } else {
      yield put(A.setStep({ cryptoCurrency, fiatCurrency, step: 'CRYPTO_SELECTION' }))
    }
  }

  const switchFix = function* ({ payload }: ReturnType<typeof A.switchFix>) {
    yield put(actions.form.change('simpleBuyCheckout', 'fix', payload.fix))
    yield put(actions.preferences.setSBCheckoutFix(payload.orderType, payload.fix))
    const newAmount = new BigNumber(payload.amount).isGreaterThan(0) ? payload.amount : undefined
    yield put(actions.form.change('simpleBuyCheckout', 'amount', newAmount))
    yield put(actions.form.focus('simpleBuyCheckout', 'amount'))
  }

  const fetchLimits = function* ({ payload }: ReturnType<typeof A.fetchLimits>) {
    const { cryptoCurrency, currency, side } = payload
    try {
      yield put(A.fetchLimitsLoading())
      let limits
      if (cryptoCurrency && side) {
        limits = yield call(api.getSBLimits, currency, ProductTypes.SIMPLEBUY, cryptoCurrency, side)
      } else {
        limits = yield call(api.getSwapLimits, currency)
      }
      yield put(A.fetchLimitsSuccess(limits))
    } catch (e) {
      const error = errorHandler(e)
      yield put(A.fetchLimitsFailure(error))
    }
  }

  const fetchCrossBorderLimits = function* ({
    payload
  }: ReturnType<typeof A.fetchCrossBorderLimits>) {
    const { currency, fromAccount, inputCurrency, outputCurrency, toAccount } = payload
    try {
      yield put(A.fetchCrossBorderLimitsLoading())
      const limitsResponse: ReturnType<typeof api.getCrossBorderTransactions> = yield call(
        api.getCrossBorderTransactions,
        inputCurrency,
        fromAccount,
        outputCurrency,
        toAccount,
        currency
      )
      yield put(A.fetchCrossBorderLimitsSuccess(limitsResponse))
    } catch (e) {
      yield put(A.fetchCrossBorderLimitsFailure(e))
    }
  }

  return {
    activateSBCard,
    addCardDetails,
    addCardFinished,
    cancelSBOrder,
    confirmOrder,
    confirmOrderPoll,
    confirmSBFundsOrder,
    createSBOrder,
    deleteSBCard,
    fetchCrossBorderLimits,
    fetchFiatEligible,
    fetchLimits,
    fetchPaymentAccount,
    fetchPaymentMethods,
    fetchSBBalances,
    fetchSBCard,
    fetchSBCardSDD,
    fetchSBCards,
    fetchSBOrders,
    fetchSBPairs,
    fetchSBQuote,
    fetchSDDEligible,
    fetchSDDVerified,
    fetchSellQuote,
    formChanged,
    handleBuyMaxAmountClick,
    handleBuyMinAmountClick,
    handleSBDepositFiatClick,
    handleSBMethodChange,
    handleSellMaxAmountClick,
    handleSellMinAmountClick,
    initializeBillingAddress,
    initializeCheckout,
    pollSBBalances,
    pollSBCard,
    pollSBOrder,
    setStepChange,
    showModal,
    switchFix
  }
}
