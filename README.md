# AGBS LIBRARY

AGBS LIBRARY is a secure digital library portal for off-campus seminary students. It supports controlled student access to PDF and EPUB study resources, admin-managed uploads, department-based categorization, AWS S3 storage, and reading activity tracking.

Live site:

- [https://www.agbslibrary.com](https://www.agbslibrary.com)
- [http://www.agbslibrary.com](http://www.agbslibrary.com)

Temporary AWS environment URL:

- [http://Agbs-library-aws-1-env.eba-8uziqsiu.us-east-1.elasticbeanstalk.com](http://Agbs-library-aws-1-env.eba-8uziqsiu.us-east-1.elasticbeanstalk.com)

GitHub repository: [https://github.com/Jayasree2020/AGBS-LIBRARY](https://github.com/Jayasree2020/AGBS-LIBRARY)

## Current Status

- Production hosting has moved from Vercel to AWS Elastic Beanstalk because the library upload scale is too large for the current Vercel fair-use limits.
- GitHub remains the source of truth for all code changes.
- Permanent file and data storage is AWS S3.
- Hostinger DNS points the public domain to the AWS Elastic Beanstalk environment.
- HTTPS is live on `www.agbslibrary.com` through AWS Certificate Manager and an Elastic Beanstalk application load balancer.
- The root domain `agbslibrary.com` depends on DNS support for root alias/CNAME records. The official production URL is `https://www.agbslibrary.com`.
- The app uses the Amazing Grace Biblical Seminary logo and a matching red, gold, flame-orange, and warm cream color system.
- Vercel, Cloudflare R2, and MongoDB are not part of the current production setup.
- Uploaded books are stored in AWS as complete files, not visible upload parts.
- Admin uploads are automatically published into the library.
- Valid PDF/EPUB files are added unless the exact same file already exists.
- The admin dashboard shows total usable storage, current used storage, remaining storage, and whether the current usage fits inside the 12-month AWS credit plan.

## What The App Does

- Student and admin login.
- Admin/director-only dashboard.
- Library browsing by department.
- Search by title, author, filename, department, format, Dewey number, Dewey class, or bibliography text.
- Protected PDF/EPUB viewing inside the app.
- Admin category correction directly from library search results.
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
- Languages
- Research Methodology
- Music
- Homiletics
- Pastoral Care and Counselling

Admins can add more categories from the dashboard.

Language books are organized under the single visible `Languages` folder. English, Greek, and Hebrew are handled as automatic subcategories under that folder for cataloging and admin correction.

## Upload Workflow

Admins can upload:

- A single PDF or EPUB.
- Multiple files.
- A folder of files.
- Multiple folder/file selections before pressing upload.
- A ZIP archive.

Supported file types:

- PDF
- EPUB
ZIP files may be selected, but only PDF and EPUB files inside the ZIP are imported.

Upload behavior:

- Every supported file is saved as an e-book resource.
- Uploads are automatically published.
- Exact duplicate PDFs/EPUBs are skipped by file hash.
- Similar filenames or similar file sizes are not enough to skip a book.
- Files are skipped only when they are not PDF/EPUB.
- Admins can clear selected files before starting an upload.
- Admins can stop an upload while it is running.
- Admins can choose files/folders more than once before upload; each selection is added to the same upload queue.
- A completion popup appears when the upload finishes.
- After upload, the admin can still use other dashboard actions.
- The book count and storage panel update after upload.

Large upload behavior:

- Large files are sent in smaller internal upload steps so Vercel can receive them.
- ZIP files are opened in the browser, and each supported PDF/EPUB inside the ZIP is uploaded separately. JPG/PNG/WEBP/GIF files are skipped.
- In AWS mode, the final file is written directly to AWS S3 instead of being kept on Vercel temporary disk.
- Admin uploads receive a temporary upload token so long batches can continue even if the normal browser login cookie is not read during one of the later file requests.
- This prevents the Vercel `ENOSPC: no space left on device` failure that happens when too many large files are copied into `/tmp`.
- The final library record always points to one complete file, not a chunk.

## Classification And Bibliography

Every uploaded e-book receives:

- Detailed DDC/Dewey Decimal-style class number.
- DDC/Dewey class label.
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
- Change a book's category from the Library page while browsing/searching.
- Update title and category.
- Replace an existing file.
- Remove a file from the library and storage.
- Continue uploading valid PDFs/EPUBs while skipping only exact duplicate files.
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
Hostinger DNS
        |
        v
AWS Elastic Beanstalk
        |
        v
AWS S3
  - agbs-library/books/
  - agbs-library/data/
  - agbs-library/tmp/
```

AWS S3 storage layout:

- `books/`: complete PDF/EPUB objects.
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

Set these in AWS hosting environment variables:

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
AWS_STORAGE_CREDIT_USD
AWS_S3_STORAGE_USD_PER_GB_MONTH
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

1. Keep the web app running on AWS Elastic Beanstalk.
2. Use AWS S3 for all permanent files and JSON records.
3. Push every code change to GitHub before deployment.
4. Deploy updated Elastic Beanstalk ZIP versions from the repository code.
5. Keep AWS HTTPS active on `www.agbslibrary.com`.
6. Keep the Elastic Beanstalk environment load-balanced for SSL.
7. Keep the site branding aligned with the seminary logo.
8. Show AWS storage capacity, real-time usage, remaining TB/GB, and 12-month credit coverage in the admin dashboard.
9. Keep uploads automated: no manual publish button.
10. Keep student uploads disabled.
11. Upload books from the admin dashboard in batches.
12. Watch the admin storage panel after uploads.
13. Use the upload log to notice repeated files while keeping the admin dashboard clean.
14. Use classification exports for library cataloging and bibliography reports.
15. Configure Google OAuth later if Gmail sign-in is required.
16. Add deeper PDF/EPUB page-location tracking later if needed.

## AWS Hosting

This repository now includes:

- `Dockerfile`
- `.dockerignore`
- `Procfile`
- `AWS_HOSTING_GUIDE.md`

Use [AWS_HOSTING_GUIDE.md](AWS_HOSTING_GUIDE.md) to deploy or update the app on AWS Elastic Beanstalk. The app uses AWS S3 for books, data records, temporary upload chunks, storage tracking, and protected file serving.

Elastic Beanstalk currently runs the Node.js app on port `8080` behind nginx. The `Procfile` starts the server with `npm start`.

Current public domain status:

- HTTPS: active on `www.agbslibrary.com`.
- Root domain: use DNS root alias/CNAME support or Route 53 if `agbslibrary.com` must resolve without `www`.

## Handover Document

For the fuller project plan and continuation notes, see:

[AGBS_LIBRARY_PROJECT_DOCUMENT.md](AGBS_LIBRARY_PROJECT_DOCUMENT.md)
