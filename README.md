# AGBS LIBRARY

AGBS LIBRARY is a secure digital library portal for off-campus seminary students. It supports controlled student access to PDF, EPUB, and image-based study resources, admin-managed uploads, department-based categorization, AWS S3 storage, and reading activity tracking.

Live site: [https://www.agbslibrary.com](https://www.agbslibrary.com)

GitHub repository: [https://github.com/Jayasree2020/AGBS-LIBRARY](https://github.com/Jayasree2020/AGBS-LIBRARY)

## Current Status

- Production is deployed on Vercel.
- Permanent file and data storage is AWS S3.
- The app uses the Amazing Grace Biblical Seminary logo and a matching red, gold, flame-orange, and warm cream color system.
- R2 and MongoDB are not part of the current production setup.
- Uploaded books are stored in AWS as complete files, not visible upload parts.
- Admin uploads are automatically published into the library.
- Duplicate files are skipped automatically without keeping a permanent duplicate table on the admin dashboard.
- The admin dashboard shows total storage left and estimated month runway for a 12-month AWS storage plan.

## What The App Does

- Student and admin login.
- Admin/director-only dashboard.
- Library browsing by department.
- Search by title, author, filename, department, format, Dewey number, Dewey class, or bibliography text.
- Protected PDF/EPUB/image viewing inside the app.
- Admin upload of files, folders, and ZIP archives.
- Browser-side ZIP opening so each supported file inside the ZIP becomes its own library item.
- Automatic category suggestion from file and folder names.
- Automatic Dewey Decimal-style e-book classification.
- Bibliography generation for each uploaded e-book.
- Export of classification and bibliography data as HTML, Word-compatible DOC, Excel-compatible XLS, CSV, or PDF.
- Student login and reading history tracking.
- Admin student account creation, password reset, and access removal.

## Library Departments

- Old Testament
- New Testament
- Christian Theology
- History of Christianity
- Christian Ministry
- Missiology
- Communication
- Christian Ethics
- Religions
- Social Analysis
- Women Studies

Admins can add more categories from the dashboard.

## Upload Workflow

Admins can upload:

- A single PDF, EPUB, or image.
- Multiple files.
- A folder of files.
- A ZIP archive.

Supported file types:

- PDF
- EPUB
- PNG
- JPG/JPEG
- WEBP
- GIF

Upload behavior:

- Every supported file is saved as an e-book resource.
- Uploads are automatically published.
- Duplicates are skipped by file hash or normalized filename plus size.
- Skipped duplicates are reported in the upload log, but the dashboard no longer keeps showing a separate duplicate upload table.
- Admins can clear selected files before starting an upload.
- Admins can stop an upload while it is running.
- After upload, the admin can still use other dashboard actions.
- The book count and storage panel update after upload.

Large upload behavior:

- Large files are sent in smaller internal upload steps so Vercel can receive them.
- ZIP files are opened in the browser, and each supported PDF/EPUB/image inside the ZIP is uploaded separately.
- In AWS mode, the final file is written directly to AWS S3 instead of being kept on Vercel temporary disk.
- Admin uploads receive a temporary upload token so long batches can continue even if the normal browser login cookie is not read during one of the later file requests.
- This prevents the Vercel `ENOSPC: no space left on device` failure that happens when too many large files are copied into `/tmp`.
- The final library record always points to one complete file, not a chunk.

## Classification And Bibliography

Every uploaded e-book receives:

- Dewey Decimal-style class number.
- Dewey class label.
- Call number.
- Title.
- Author, when detected safely.
- Department/category.
- Format.
- Original filename.
- Confidence level.
- Bibliography entry.

The automatic classification is advisory. It uses department, filename, and folder path words. Admins can update the category and title after upload.

Export formats available in the admin dashboard:

- HTML
- Word-compatible DOC
- Excel-compatible XLS
- CSV
- PDF

## Admin File Management

Admins can:

- View protected files.
- Update title and category.
- Replace an existing file.
- Remove a file from the library and storage.
- Continue uploading without a permanent skipped-duplicates section taking space on the dashboard.
- Create student logins.
- Reset student passwords.
- Remove student access after course completion.

There is no publish-pending step. Uploads go directly into the library.

## Student Experience

Students can:

- Sign in with email/password.
- Search the library by any word.
- Filter by department.
- Open published books through the protected reader route.

Students cannot:

- Upload files.
- Access admin pages.
- See other students' history.
- See public AWS storage links.

Download buttons are not provided by the app. Browser-level screenshots or copying cannot be fully prevented.

## Tracking

The app records:

- Login sessions.
- Logout/session expiry when available.
- Resource opened.
- Reading session start and end.
- Category accessed.
- Reading duration.

Admin reports show:

- Student email/name.
- Login count.
- Books opened.
- Reading hours.

## Production Architecture

```text
Student/Admin Browser
        |
        v
Vercel App / Serverless API
        |
        v
AWS S3
  - books/
  - data/
  - tmp/uploads/
```

AWS S3 storage layout:

- `books/`: complete PDF/EPUB/image objects.
- `data/`: JSON records for users, resources, categories, sessions, logs, and skipped uploads.
- `tmp/uploads/`: temporary upload chunks used only while a file is being completed.

Core data collections:

- `users`
- `categories`
- `resources`
- `uploadBatches`
- `loginSessions`
- `readingSessions`
- `accessEvents`
- `skippedUploads`

## Environment Variables

Set these in Vercel Project Settings:

```text
ADMIN_EMAIL
ADMIN_BOOTSTRAP_PASSWORD
SESSION_SECRET
BASE_URL
AWS_REGION
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
AWS_S3_BUCKET
AWS_S3_PREFIX
AWS_STORAGE_BUDGET_GB
AWS_STORAGE_PLAN_MONTHS
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_REDIRECT_URI
```

Important:

- Never commit real secrets to GitHub.
- Never place AWS keys, GitHub tokens, Vercel tokens, admin passwords, OAuth secrets, or API keys in frontend files.
- Production should show `storageProvider: aws-s3` from `/api/config`.

## Local Development

```powershell
node server.js
```

Then open:

[http://localhost:3000](http://localhost:3000)

On this Windows workspace, `START-AGBS-LIBRARY.cmd` can also start the local server.

## Current Plan

1. Use Vercel only for the web app and API.
2. Use AWS S3 for all permanent files and JSON records.
3. Keep the site branding aligned with the seminary logo.
4. Keep uploads automated: no manual publish button.
5. Keep student uploads disabled.
6. Upload books from the admin dashboard in batches.
7. Watch the admin storage panel after uploads.
8. Use the upload log to notice repeated files while keeping the admin dashboard clean.
9. Use classification exports for library cataloging and bibliography reports.
10. Configure Google OAuth later if Gmail sign-in is required.
11. Add deeper PDF/EPUB page-location tracking later if needed.

## Handover Document

For the fuller project plan and continuation notes, see:

[AGBS_LIBRARY_PROJECT_DOCUMENT.md](AGBS_LIBRARY_PROJECT_DOCUMENT.md)
