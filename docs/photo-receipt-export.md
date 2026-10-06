# Photos and receipt file exports

The Photos page, its Receipts tab, and each job’s shared photo feed offer an Export button. The office Receipts page offers Export receipt files alongside its existing CSV action.

1. Choose the job, or all jobs the signed-in account can access.
2. Choose all dates or an inclusive custom date range. Photos use their capture date (saved date when unknown) in the device’s local time. Receipts use their purchase date, or local saved date when unknown.
3. Review the matching list, preview a photo if needed, and select the files to keep.
4. Tap Prepare export. This reads original saved media through fresh private signed links. Original receipt PDFs are prepared separately from their image preview.
5. Download ZIP, download an individual prepared file, or tap Share / Email. Sharing opens the device’s own chooser; the user chooses Mail or another destination and completes sending there. Browsers without file sharing keep download available.

The office’s current saved-month, category and billing filters also apply. Its saved-month filter is separate from the receipt purchase-date range; when both are present the export uses their intersection. CSV behavior stays unchanged.

Exports page past the gallery’s 60 photos and office table’s 500 receipts. At most 5000 records are loaded per scope, with a probe that refuses a larger result instead of truncating it. Preparation has a 50 MiB payload limit, three concurrent workers and a 60-second deadline per record including signing. This is a payload limit, not a guarantee of peak JavaScript heap use. Use smaller selections/date ranges for larger jobs. Network and quota failures name the unavailable files and clearly identify an incomplete export. The user can download only available files or retry; there is no empty or silently complete archive.

Cancel preparation and closing the dialog abort its active work. Private job lists and export metadata are keyed to the original user and sign-in generation. A sign-out, account change or unmount invalidates every export handler and drops late preparation, preview and ZIP results; a delayed ZIP cannot start a download after that boundary. Already-started system sharing cannot be recalled. A late signing response cannot start a new download; already-issued storage signing requests may finish in the SDK. Closing never shares or downloads automatically. Export does not change uploads, pending photo queues, receipt flags, authentication, row security, or storage permissions. Only files the existing signed-in account can read are eligible; trashed photos and unsaved local uploads are excluded. Private URLs are not included in the ZIP or a public manifest.

The export feature can ship independently on the existing app and remain available in the later redesign. Its release keeps the normal production-base CI and installed-app gates, with an owner-device Mail/Save to Files check; local native sharing tests use a mock share sheet that captures actual File bytes, not an actual email.
