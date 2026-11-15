---
title: "Search inside your scans and PDFs without uploading them: how on-device OCR works"
slug: ocr-search-scans-pdfs
date: 2026-11-15
description: "Deeperguard reads text from photos, scans and PDFs in your browser, so you can search them while the server only stores encrypted data. What it does and its limits."
cover_image: /static/blog/ocr-search-scans-pdfs.svg
cover_alt: "Abstract slate-blue illustration of a document page and a magnifying glass, with no text"
draft: false
---

A lease, a vaccination card, a receipt you photographed in a hurry. Attachments like these are useful mostly when you can find them again, and that usually means searching the text inside them. The usual way to get that text is to upload the file to a service that reads it for you. That would defeat the point of an encrypted vault, so Deeperguard does the reading on your own device.

## What happens when you attach a file

When you attach a file to a note, your browser encrypts the bytes with your vault key before anything is stored or synced. The file is capped at 50 MB, and your plan's storage quota applies as well. If you try to attach the exact same bytes twice, the app refuses the second copy and tells you where the first one lives. Duplicating a note is the deliberate way to keep a second copy.

The text recognition step runs in the same place. The OCR engine is Tesseract, compiled to WebAssembly and shipped with the app's own static files, and PDFs are rendered with pdf.js. Your browser decrypts the file locally, turns pages into images, and reads the text. The comment at the top of the engine says it plainly: nothing is sent to the server for OCR.

The recognised text is then stored as part of the attachment item, and that item is encrypted like everything else before it syncs. When another of your devices receives it, it adopts the existing text instead of running OCR again.

## Photos, scans and PDFs

You can add several photos as pages of one scan, up to six pages. Pages can be removed before you save. When more than one page is involved, the app combines them into a single PDF in your browser. iPhone photos in HEIC format are converted to JPEG locally first.

For PDFs, every page is read. For the highlight boxes that show where a match sits on the page there is a cap of 1,500 boxes; the text itself is not capped that way.

Recognition uses English and Dutch language data. That data is fetched from the app's own static files when a scan starts, not with the first page load, so the first scan on a device needs a connection. On iPhones and installed home-screen apps the app works at a lower image size, because those environments tend to reload the page when memory runs short.

## Using it in practice

- **Good light, flat page.** OCR quality depends mostly on the photo. A sharp, evenly lit, straight-on shot beats any setting. The app prepares photos before recognition, but it cannot rescue a blurry picture.
- **Use real PDFs when you have them.** A PDF exported from a bank or an employer is cleaner than a photo of a printout.
- **Check the result.** Recognised text can contain mistakes, especially in handwriting, stamps, small print and tables. Treat a search hit as a pointer to the page, not as a transcript to rely on.
- **Search finds what was read.** If a word was misread, searching for the correct word will not find it. A distinctive part of the text, such as an amount or a reference number, is more forgiving than a whole sentence.
- **Keep an eye on storage.** Photos are large. The free plan has 50 MB of storage, so for many scans a PDF is cheaper than a stack of photos.

## What the server can see

The server holds encrypted attachment data and the encrypted items that carry the recognised text. It does not receive your plaintext files or the recognised text for OCR. It can still see the ordinary metadata of a sync service: that you have items, roughly how large the encrypted blobs are, and when they were created or changed. The project's privacy document lists attachment bytes, OCR text and search hit boxes as things that do not leave your device unencrypted in the default configuration.

There is an older server-side OCR path in the code. It is switched off by default and only becomes active if whoever runs the server sets a specific environment option. The project's own documentation says it should not be used on a public instance. If you use an instance run by someone else, check for yourself rather than assuming; our post on verifying zero-knowledge yourself shows how.

## What it does not do

- **It does not make OCR perfect.** Results vary with image quality, fonts and language. There is no guarantee that every word is found.
- **It only reads English and Dutch.** Other languages and scripts may come out badly or not at all.
- **It does not work while the vault is locked.** Decryption and recognition need your key in your browser, so nothing is searchable when the vault is locked.
- **It does not hide metadata.** File sizes, timing and the number of items are visible to the server.
- **It does not protect a compromised device.** If someone controls the browser you are using, they can see what you see. Our post on browser hygiene covers the basics.
- **It does not index your documents on the server.** There is no server-side indexing in the default setup.

On-device OCR costs some battery and a few seconds per page. That is the price of keeping the reading on your side, and for documents you would rather not hand to anyone, it is usually the right trade.
