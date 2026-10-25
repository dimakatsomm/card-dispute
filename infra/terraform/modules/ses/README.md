# ses

Sender identity, a configuration set that publishes SEND, DELIVERY, BOUNCE, COMPLAINT and REJECT events to the
default EventBridge bus, and a rule that copies them to the 1-day queue `cd-ses-events` for E-03 delivery
checks. The configuration set is the identity default, so the notifier does not have to name it.

## Sandbox

The account stays in the SES sandbox: 200 messages per day, 1 per second, and both sender and recipient must
be verified identities. `dimakatsomm@icloud.com` is the sender and the only test recipient (ADR-046). Leaving the
sandbox is a separate AWS request and is not part of `dev`.

## OWN-6 verification click

`terraform apply` creates the identity in the *pending* state and SES emails a verification link to the address.
The owner clicks it (OWN-6). Until then every send fails with `MessageRejected` and no event reaches `cd-ses-events`.
Check the state with `aws sesv2 get-email-identity --email-identity dimakatsomm@icloud.com --region eu-north-1`
(`VerifiedForSendingStatus: true`).
