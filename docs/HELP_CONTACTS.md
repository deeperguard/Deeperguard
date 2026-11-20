Contacts keep your address book in the same encrypted vault as your notes. This page explains how to add contacts, bring them in from other programs, deal with duplicates, take them out again, and what the server can and cannot see. Open the **Contacts** tab (between Agenda and 2FA) to follow along. The vault must be unlocked.

## Adding a contact

1. Open the Contacts tab and press **+** (or **Add contact** when the list is empty).
2. Fill in what you have: name, phone numbers, email addresses, addresses, websites, a photo, labels and a note. Every phone, email, address and website can have its own type, such as home or work.
3. Save. The contact appears in the list, sorted by name, and is saved encrypted in your vault. It syncs to your other devices like a note.

Use the search box to find a contact by name, number, email or label. Open a contact to call (`tel:`), write (`mailto:`) or copy a value. Those links are handed to your device; nothing is looked up online. Star a contact to keep it at the top as a favourite. Delete a contact from its detail view; it is removed from all your devices.

## Importing contacts

Press **Import** in the Contacts pane (on a narrow screen it is under the **⋯** button). Choose one or more files, or drop them on the window. The format is recognised from what is inside the file, not from its name.

| Format | Typical file |
| --- | --- |
| vCard 2.1, 3.0 and 4.0 | `.vcf`, `.vcard` |
| CSV (Google, Outlook, Thunderbird and Yahoo; other CSV files through a column mapping) | `.csv` |
| LDIF | `.ldif` |
| jCard | `.json`, `.jcf` |

The files are read in your browser and are **not uploaded**. Nothing is saved until you have seen the preview and pressed **Import**. If a file shows strange characters, pick another encoding in the preview. If a CSV has columns the app does not know, you are asked which column is which before the preview. After the import you can press **Undo** in the message or in the dialog, as long as the vault stays unlocked.

A vCard file is the best choice when a program offers it, because it carries the most fields. CSV files lose some detail.

### Export from Google Contacts

1. Open contacts.google.com and sign in.
2. Choose **Export** in the left menu.
3. Select the contacts (or all) and the format **vCard (for iOS Contacts)** or **Google CSV**, then export.
4. Import the downloaded file here.

### Export from Apple Contacts and iCloud

1. On a Mac: open the Contacts app, select the contacts (Cmd+A for all) and choose **File → Export → Export vCard**.
2. On iCloud.com: open Contacts, select all contacts, open the settings (gear) menu and choose **Export vCard**.
3. Import the `.vcf` file here.

### Export from Outlook

1. Outlook.com or the new Outlook: open People, choose **Manage → Export contacts** and download the CSV file.
2. Classic Outlook for Windows: choose **File → Open & Export → Import/Export → Export to a file → Comma Separated Values**, pick your Contacts folder and save the file.
3. Import the CSV here. Outlook writes its column names in the language of the program; English and Dutch headers are recognised, other languages go through the column mapping.

### Export from Android

1. Open the Contacts app (or the Google Contacts app).
2. Open the menu, then **Settings** (or **Fix & manage**) and choose **Export** to a `.vcf` file. Choose where to save it.
3. Move the file to the device you are using and import it here.

If your phone syncs its contacts with Google, you can also export from Google Contacts as described above.

### Export from Thunderbird

1. Open the Address Book and select the address book to export.
2. Choose **Tools → Export** (in recent versions: right-click the address book and choose **Export**).
3. Save as **vCard**, **CSV** or **LDIF**. All three can be imported here.

### Export from Proton

1. Open Proton Contacts.
2. Open **Settings** and choose **Export contacts**.
3. Import the downloaded `.vcf` file here.

Menu names in other programs change between versions. If you do not find an entry, search that program's help for "export contacts" and choose vCard or CSV.

## Duplicates

When an import contains a contact that matches one you already have, or that occurs twice in the files, the preview lists it. Contacts match when they share an email address or a phone number (spaces, dashes and brackets are ignored), or the same name. For each one you choose:

- **Skip**: the contact is not imported.
- **Merge**: what is missing is added to the contact you already have; its existing values are kept and nothing is deleted.
- **Keep both**: the contact is imported as a new one.

Skip is the default. A match on the name alone is kept as a new contact unless you choose otherwise. You can also set one choice for all duplicates at once.

To clean up contacts that are already in your vault, press **Find duplicates** in the Contacts pane. Groups of contacts with the same email address, phone number or name are listed; pick the contact to keep and merge the group or remove the others.

## Exporting contacts

- **Export** in the Contacts pane writes a file with the contacts shown in the list (all of them when no search or label is active), or only the ones you ticked after pressing **Select**. Choose **vCard 3.0**, **vCard 4.0** or **CSV (Google Contacts columns)**. CSV loses some fields; use vCard for a complete export.
- **Share as vCard** in a contact's detail exports that one contact.
- **Settings → Export everything readable (ZIP)** includes all contacts as `contacts/contacts.vcf` (vCard 3.0, with photos) next to your notes and agenda.

These exports are **not encrypted**: anyone who gets the file can read it, and your vault password does not protect it. You must type your vault password again before the file is made. The file is built on your device and nothing is sent to the server. Delete it when you are done. For a safe copy use the encrypted backup file in Settings; it includes your contacts and restores them.

## What the server can see

Contacts are encrypted in your browser with your vault key, exactly like notes and agenda items. The server stores only ciphertext. It cannot read names, numbers, addresses, photos, labels or notes, and it cannot tell a contact from a note. It learns what it already learns for notes: how many items your account holds, their sizes and when they changed. A large import shows up as many small items arriving in a short time.

Imported files are parsed in your browser and never uploaded. Text from a contact or a file is shown as plain text, never as HTML. When you lock the vault or sign out, the contacts are cleared from memory. For the wider picture see the [privacy page](/privacy).

## Limits

An import takes up to 10,000 contacts, and files up to 64 MB each. Photos are resized in the browser. Links to photos inside a file are not opened. A contact can hold up to 50 phone numbers, emails, addresses and websites each.
