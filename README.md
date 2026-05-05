# AGBS LIBRARY

AGBS LIBRARY is a secure digital library for off-campus seminary students. It is designed for controlled access to PDF, EPUB, and image-based study resources, with department-based categorization, admin-managed uploads, and reading activity tracking.

Live site: [https://www.agbslibrary.com](https://www.agbslibrary.com)

Fallback Vercel URL: [https://agbs-library.vercel.app](https://agbs-library.vercel.app)

## What It Does

- Provides student and admin login.
- Organizes resources by seminary departments.
- Lets admins upload individual files, ZIP files, or whole folders.
- Supports PDF, EPUB, PNG, JPG, JPEG, WEBP, and GIF files.
- Suggests categories from file and folder names.
- Adds uploaded resources directly to the library after upload.
- Skips duplicate files automatically and shows skipped files only to admins.
- Lets admins view, save/update metadata, replace, and remove uploaded files.
- Tracks login sessions, reading sessions, opened books, and reading time.
- Keeps download links out of the interface and serves files through authenticated routes.

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

## Admin Upload Workflow

Admins can upload normal files, a ZIP archive, or a full folder. The upload screen supports two modes:

- `Auto-categorize`: the app uses file and folder names to suggest the correct department.
- `Manual category`: the whole upload batch goes into one selected department.

Uploaded resources are published automatically and appear immediately in the student library list. Duplicate files are skipped instead of being added again. Admins can review skipped files in the admin dashboard and re-upload only when needed.

Admins can manage files after upload:

- `View`: open the protected file route.
- `Save`: update title/category edits.
- `Replace`: upload a new file in place of an existing file.
- `Remove`: delete the library record and stored file.

Large uploads are sent in smaller internal chunks so Vercel can receive them safely. The finished library item is still the original PDF, EPUB, or image file, not a visible chunk or part.

## Deployment

The app is deployed on Vercel under the `agbs-library` project and is connected to the custom domain:

[https://www.agbslibrary.com](https://www.agbslibrary.com)

Vercel is suitable for the live app interface. For long-term production use with many large PDF/EPUB files, durable file storage is required. The current production setup uses AWS S3 through the `AWS_*` environment variables below. With AWS S3 enabled, every PDF/EPUB/image is stored as one object under `books/`, and small app records are stored as JSON under `data/`. Vercel serverless temporary storage can reset and should not be treated as permanent book storage by itself.

## Environment Variables

Set these in Vercel Project Settings:

```text
ADMIN_EMAIL
ADMIN_BOOTSTRAP_PASSWORD
SESSION_SECRET
BASE_URL
MONGODB_URI
MONGODB_DB
AWS_REGION
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
AWS_S3_BUCKET
AWS_S3_PREFIX
R2_ACCOUNT_ID
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
R2_BUCKET
R2_PREFIX
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_REDIRECT_URI
```

`ADMIN_BOOTSTRAP_PASSWORD`, OAuth secrets, database URLs, AWS/R2 keys, and API keys must stay in Vercel environment variables. Do not commit them to GitHub.

## Local Development

```powershell
node server.js
```

Then open:

[http://localhost:3000](http://localhost:3000)

On this Windows workspace, `START-AGBS-LIBRARY.cmd` can also start the local server.

## Security Notes

- Secrets are kept out of the repository.
- Students cannot upload resources.
- Admin-only routes are protected server-side.
- Resources are served through authenticated app routes.
- Browser-level screenshots or copying cannot be fully prevented, but ordinary public download exposure is avoided.

## Handover Document

For a fuller project summary and continuation notes, see:

[AGBS_LIBRARY_PROJECT_DOCUMENT.md](AGBS_LIBRARY_PROJECT_DOCUMENT.md)
