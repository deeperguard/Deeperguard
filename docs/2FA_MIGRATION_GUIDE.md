# Moving your 2FA accounts to Deeperguard

This guide is for users. Everything happens in your browser; your secrets are
saved encrypted in your vault and never reach the server in readable form.

## From Authy

Authy has no official export, so Deeperguard has no Authy import. We do not
build, link to or recommend tools that extract secrets from Authy.

The reliable route is to set up 2FA again for each site:

1. Sign in to the site and open its security or 2FA settings.
2. Choose to set up a new authenticator app (or turn 2FA off and on again).
3. In Deeperguard open 2FA, then Import, then "I'm coming from Authy" and
   press "Open QR scanner". Scan the new QR code and add the account.
4. Check on the site that a code from Deeperguard works.
5. Repeat for every account.

Tip: only delete Authy, or its accounts, once everything works. Setting 2FA up
again also gives each account a new secret.

If you already have your secrets as a list of `otpauth://` links, use the
otpauth list import described below.

## From Google Authenticator

Use "Export accounts" in Google Authenticator. It shows QR codes that start
with `otpauth-migration://`. Scanning these is not supported yet (see
`2FA_IMPORT_SPEC.md`). Until it is, scan the new QR code of each site as
described for Authy, or paste a list of `otpauth://` links.

## From Aegis

Export your vault in Aegis (plain JSON or password-protected). In
Deeperguard choose 2FA, Import, Choose file. Enter the export password if
asked, check the preview, then import. Delete the export file afterwards: a
plain export contains your secrets.

## From 2FAS

Export a backup in 2FAS (plain or password-protected) and import it the same
way as Aegis. Delete the file afterwards.

## From a list of otpauth links

Paste one `otpauth://` link per line (or choose a text file) in 2FA, Import,
and check the preview before importing.

## After moving

Keep the old app until you have confirmed that each account works in
Deeperguard.
