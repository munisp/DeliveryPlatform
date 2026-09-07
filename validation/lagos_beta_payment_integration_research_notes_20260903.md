# Lagos Beta Payment Integration Research Notes — 2026-09-03

## Sources reviewed

1. Central Bank of Nigeria Payment Service Providers: https://www.cbn.gov.ng/PaymentsSystem/PSPs.html
2. Central Bank of Nigeria Payments System Supervision: https://www.cbn.gov.ng/PaymentsSystem/
3. Paystack Multi-split Payments documentation: https://paystack.com/docs/payments/multi-split-payments/
4. Paystack Webhooks documentation: https://paystack.com/docs/payments/webhooks/

## Findings retained for architecture

- CBN identifies itself as the main payments-system regulator and publishes authorised PSP categories and licensees. The beta should use an appropriately licensed provider/bank for payment collection and payout rather than operating a wallet, payment switch, or funds custody model without specific legal approval.
- CBN materials highlight payment-system oversight, merchant due diligence, payment risk/information-security controls, card fraud controls, and payment-channel frameworks. The platform must therefore remain the merchant/marketplace application layer, retain an immutable internal accounting ledger, and reconcile to provider settlement records.
- Paystack documents multi-split settlement across a merchant payout account and one or more subaccounts; it supports flat or percentage split configurations, fixed/dynamic splits, and exposes split information in a successful payment webhook. This is a usable provider capability but it must be confirmed commercially and legally for the platform’s specific marketplace, tax, refund, dispute, and driver relationship model.
- Paystack webhook documentation requires validation of an HMAC-SHA512 `x-paystack-signature` over the payload and describes optional IP allowlisting. The design must independently verify signatures, store an idempotency fingerprint/event ID, acknowledge quickly after durable enqueue, and reconcile provider status through a server-to-server verification endpoint before releasing irreversible downstream actions.

## Scope warning

Provider documents demonstrate technical functionality, not legal permission to operate a regulated passenger-transport marketplace or to retain/route customer funds. Nigerian payments counsel, the selected CBN-licensed provider/bank, tax advisers, and insurance/transport counsel must approve the exact contract and funds-flow before live operation.
