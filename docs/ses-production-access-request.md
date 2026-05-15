# SES Production Access Request Draft

Use this draft when re-applying for Amazon SES production access for `canyin.uk` in `us-east-1`.

## Suggested AWS Form Values

- Mail type: Transactional
- Website URL: `https://lineme.tech`
- Contact language: English
- Region: `us-east-1`
- From domain: `canyin.uk`
- Primary from address: `chat@canyin.uk`

## Use Case Description

We use Amazon SES to send transactional emails for mailsdev, a self-hosted mail workflow service used by our own team and authorized product users.

The mail is sent only after a user-initiated action or as part of an expected product workflow, such as verification codes, mailbox claim/login confirmation, support replies, and direct notification emails from our application.

We do not purchase, scrape, rent, or import third-party mailing lists. We do not use SES for bulk marketing campaigns. All recipients are users who directly interact with our product or people our users explicitly choose to contact through the product.

Our sending domain `canyin.uk` is already verified in SES with DKIM enabled. We monitor bounce and complaint signals, keep sending volume low and predictable, and will immediately suppress problematic recipients if needed. We are requesting production access so we can send transactional mail to external recipient addresses beyond the SES sandbox restrictions.

## Shorter Version

We use Amazon SES for transactional email only. Messages are triggered by user actions in our product, including verification codes, mailbox claim/login confirmation, support replies, and direct notifications. We do not send marketing campaigns or use purchased mailing lists. Our domain `canyin.uk` is verified with DKIM enabled, and we monitor bounce and complaint events. We need production access in `us-east-1` so our application can send transactional mail to external recipients.

## Notes

- Avoid phrases like "bulk sending", "campaign", or "newsletter".
- Emphasize transactional usage and user-initiated mail.
- Mention that the domain is verified and DKIM is enabled.
- Keep the wording factual and specific.
