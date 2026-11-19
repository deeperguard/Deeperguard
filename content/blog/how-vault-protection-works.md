---
title: "Two locks, one vault: how sign-in, 2FA, the recovery key and backups fit together"
slug: how-vault-protection-works
date: 2026-11-18
description: "Signing in and unlocking your vault are two different locks. We follow one user from a new account through a lost phone, a forgotten master password and a restore, and explain what each setting does, what our server can still see, and what cannot be recovered."
cover_image: /static/blog/how-vault-protection-works.svg
cover_alt: "Abstract dark blue background with two padlocks side by side, joined by a dashed line, no text"
draft: false
---

Deeperguard has quite a few security settings: an account password, passkeys, 2FA, a master password, recovery codes, a vault recovery key and several kinds of backup. Each one makes sense on its own. Together they can look like a maze. This post walks through them in the order you would actually meet them, by following one user through a year with the app.

## Two locks

Everything in this post belongs to one of two locks:

1. **The account lock: signing in.** This proves to Deeperguard that the account is yours. You use your account password, a passkey, and 2FA if you turned it on. Signing in gives you a session. It does not open a single note.
2. **The vault lock: unlocking.** This opens your notes on your device. Your notes are stored encrypted, and the key that opens them is derived from your master password inside your browser. The server never receives that key.

Each lock has its own safety net:

- **Recovery codes** help you *sign in* if you lose your passkeys. They never open your vault.
- **The vault recovery key** opens your *vault* if you forget your master password. It does not sign you in.

The two are not interchangeable. That is the one thing to remember from this post. The security part of Settings is built the same way. It has five numbered groups, in this order: **Sign in**, **Open the vault**, **If something goes wrong**, **Keep a copy**, and **Devices and sessions**. The checklist at the end of this post uses the same order.

## Day 0: creating an account

Sam creates an account with an e-mail address and a password. At the start, the account password and the master password are the same password, but the app turns it into two different secrets:

- **For signing in**, the browser computes a value from the password and stores a verifier on the server. When Sam signs in later, the browser proves it knows the password without sending it. The server keeps only that proof, never the password.
- **For the vault**, the browser runs the password through Argon2id with a random salt to get the vault key. Every note and attachment is encrypted with AES-256-GCM on Sam's device before it is synced. The server stores the salt and the encrypted data, not the key.

Because both values come from the same password but with different salts and steps, the sign-in verifier on the server is not the vault key.

Right after the account is created, the app shows Sam's **vault recovery key**: eight groups of four characters plus a short check group, made from 160 random bits generated in the browser. Before the account counts as set up, Sam ticks "I stored my recovery key" and types one group of the key back, so the app knows it was written down correctly. The server stores a copy of the vault key that is encrypted with the recovery key. It never receives the recovery key itself, so it cannot read it and cannot show it again.

If your account is older than the recovery key feature, you do not have one yet. After you unlock, the app offers to create it. You can also create it at any time: open Settings, go to the group **If something goes wrong** (group 3) and choose **Create recovery key**. Creating it does not change or re-encrypt your notes; it only adds that second, encrypted copy of the vault key.

## A normal day

Sam opens Deeperguard on a laptop and signs in. With 2FA on, sign-in also asks for a 6-digit code from an authenticator app. 2FA protects only the Deeperguard sign-in. The 2FA tab inside the app, where you can keep codes for other websites, is separate.

Then Sam types the master password to unlock the vault. On the phone, Sam has added a passkey, so signing in there is a fingerprint instead of a password. A passkey can also open the vault, but only if Sam turns on vault unlock for that passkey, and only where the browser and the passkey support it. The master password keeps working either way. Both options are in Settings. You add passkeys in the group **Sign in** (group 1), and you find vault unlock with a passkey in the group **Open the vault** (group 2).

When Sam walks away, the vault locks. **Lock after idle** locks it after a set time without input, and **Lock when leaving the app** locks it when Sam switches away. Locking removes the vault key and the decrypted notes from the tab, as far as the browser allows. It does not sign Sam out.

### What the server can still see

Encryption hides the content of your notes, not everything around them. Our server knows your e-mail address and which devices are signed in to your account. It can see how many items you have, roughly how large they are, and when they change. It also knows whether you have a vault recovery key and when it was created. It cannot read your notes, your master password, your vault key or your recovery key.

## Day 40: Sam loses the phone

The phone held a passkey and, in Sam's case, the authenticator app for 2FA. Here is what helps, in order:

1. **Sign out the lost phone.** On the laptop, Sam opens Settings and goes to the group **Devices and sessions** (group 5), which lists every signed-in device. **Sign out** ends the session of the lost phone. It does not change any password.
2. **Remove the lost passkey** from the Passkeys list in the group **Sign in** (group 1).
3. **Signing in again on a new phone.** The account password still works, unless Sam turned on **Disable password sign-in**. If Sam relies on passkeys alone, another passkey or a **recovery code** gets Sam in. Recovery codes have to be set up beforehand: you need two passkeys before you can create them, each code works once, and new codes only start working after a waiting period of at least 72 hours.
4. **2FA still needs a code.** A recovery code does not skip 2FA: if 2FA is on, sign-in still asks for the 6-digit code afterwards, and turning 2FA off also needs a current code. Deeperguard has no codes that replace your authenticator app. So the backup that matters here is the one your authenticator app makes of itself; without it, you may not be able to sign in. Sam had turned that backup on, restored the app on the new phone, and was back in.

None of this touched the vault. Sam's master password and recovery key still worked exactly as before.

## Day 90: Sam forgets the master password

After a holiday, the master password is just gone. Recovery codes cannot help here, because they only sign you in. Deeperguard cannot help either: we do not have the master password or the vault key, so there is nothing for us to reset.

This is what the vault recovery key is for:

1. Sam signs in first, as usual. The recovery step only works inside a signed-in session, with 2FA if it is on.
2. On the unlock screen, Sam chooses **Forgot your password? Use your recovery key** and types the key. It is not saved on the device.
3. The browser uses the key to open the encrypted copy of the vault key, and Sam picks a new master password.
4. The app shows a **new** recovery key. Sam confirms it is stored before anything changes on the server.
5. All notes are re-encrypted under the new key on Sam's device and synced.
6. The new password and the new recovery key take effect, and the old recovery key stops working. Every other device is signed out, and Sam gets an e-mail saying the recovery key was used.

The server also limits guessing. After five failed recovery key checks, recovery with the key is locked for 15 minutes, and each new lock doubles that time, up to 24 hours. A lock also sends an e-mail. It does not block normal sign-in or unlocking with the master password.

Treat the recovery key like your master password. Someone who has it and can also sign in to your account can open your notes. Keep it away from your devices: on paper at home, for example.

### What cannot be recovered

If both the master password and the vault recovery key are lost, the notes in your vault cannot be opened again: not by you, and not by us. Your encrypted backups are locked with the same vault key, so they cannot be opened either. The only copies left would be a readable export you saved earlier, or a device that still has the vault unlocked. If you have one of those, save a readable export from it right away.

## Day 200: restoring from a backup

Recovery codes and the recovery key protect access. They do not protect against deleting the wrong folder, or a sync going wrong. That is what a backup is for. In Settings, the group **Keep a copy** (group 4) offers these options:

- **Backup file**: **Save backup file** downloads a `.dgbackup` file, encrypted on your device with your vault key.
- **Readable export (not encrypted)**: a ZIP with your notes as Markdown plus attachments, built on your device. Anyone who has the file can read it, so store it carefully.
- **Google Drive** and **Dropbox**: the same encrypted backup, uploaded from your browser to your own account. You can also let it run once a day while the app is open, online and unlocked. If the server has no key set up for Google Drive or Dropbox, Settings asks for one from your own developer account and explains how to get it.
- **Email backup**: an encrypted archive (`deeperguard-backup.enc.json.gz`) built by our server from the encrypted data it stores for you, sent to a backup address you have verified with a code, now or daily. If the archive is too large to e-mail, the mail leaves out the largest attachments.
- **pCloud backup**: when it is turned on, Deeperguard uploads your already encrypted vault data once a day to a folder for your account in the pCloud account of the Deeperguard service, and e-mails you the result (or only when a run fails, if you choose that). It is off by default, and the switch stays off if this option is not available on the server. pCloud and Deeperguard cannot read the content, but they can see its size, the times of the backups and the number of files.

Sam deletes a folder by mistake, signs in, unlocks, and chooses **Restore Deeperguard backup**. The app asks whether to **Merge** (add new items and update changed ones) or **Add missing only** (never change existing notes), and then restores.

One thing to know: restore opens the backup with the vault key you are using now. A backup made before a master password change or a recovery was encrypted with the old key, so it will not open in the vault afterwards. Make a fresh backup after either one.

Passkeys, 2FA for signing in, Google Drive, Dropbox, email backup and pCloud backup are not part of every plan. The backup file and the readable export under **Keep a copy** are available on every plan. Settings marks the ones your plan does not include.

## What to set up today

In the same order as Settings:

1. **Sign in.** Check your **Account password**. Under **Passkeys**, add one on each device you use often. Turn on **2FA for signing in to Deeperguard**, and turn on the backup in your authenticator app.
2. **Open the vault.** Choose a strong **Master password**. Under **Locking**, pick **Lock after idle** and **Lock when leaving the app** settings that suit you. If you like, turn on **Open the vault with a passkey** for your phone.
3. **If something goes wrong.** Under **Recovery codes (account sign-in)**, choose **Generate recovery codes** once you have two passkeys. Create your **Vault recovery key** and store it away from your devices.
4. **Keep a copy.** Save a **Backup file** now, and set up one automatic option if your plan includes it. Make a new backup after you change your master password.
5. **Devices and sessions.** Look through **Signed-in devices** and sign out anything you do not recognise.

Two locks, two safety nets, one copy kept somewhere else. That is the whole system.
