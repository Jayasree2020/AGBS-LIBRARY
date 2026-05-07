# AGBS LIBRARY Project Plan And Handover

## 1. Project Summary

AGBS LIBRARY is a secure digital seminary library for off-campus students. It allows students to sign in, search library resources, read approved PDF/EPUB files inside the app, and have their reading activity tracked for admin/director review.

Admins manage:

- Book uploads.
- Categories/departments.
- Student accounts.
- File updates/removal.
- Category correction from the Library search view.
- Exact duplicate PDF/EPUB files are skipped during upload.
- Classification and bibliography exports.
- Usage reports.
- AWS storage tracking.

Live site: https://www.agbslibrary.com

GitHub repository: https://github.com/Jayasree2020/AGBS-LIBRARY

Vercel project: `agbs-library`

Production storage: AWS S3

Branding: Amazing Grace Biblical Seminary logo with red, gold, flame-orange, and warm cream interface colors.

## 2. Current Production Decision

The current production setup is:

```text
Vercel = web app and serverless API
AWS S3 = permanent books and JSON data records
```

R2 and MongoDB are not used in the current production plan.

Reasons:

- AWS credits are available.
- Books need large, permanent object storage.
- Vercel serverless disk is temporary and small.
- S3 can store very large numbers of books as complete files.

Important production rule:

Uploaded books must not depend on Vercel local file storage. Vercel temporary storage can fill up during large uploads and cause `ENOSPC: no space left on device`. The app now sends final files into AWS S3 in AWS mode.

## 3. User Roles

### Student

Students can:

- Sign in.
- Search by any word.
- Filter by category.
- Open published resources.
- Read protected resources.

Students cannot:

- Upload files.
- See admin pages.
- See other student records.
- Access public AWS file links.

### Admin

Admins can:

- Upload books.
- Upload folders.
- Upload ZIP files.
- Stop an upload.
- Clear selected files before upload.
- Update title/category.
- Change category directly from library search results when a book is found in the wrong department.
- Replace files.
- Remove files.
- Add categories.
- Add student accounts.
- Reset temporary passwords.
- Remove student access after course completion.
- View student history.
- Download classification and bibliography reports.
- View storage left and estimated runway.

### Director

The app supports `director` as a staff role with admin-style access.

## 3A. Branding And Interface Plan

The site should use the seminary logo as a visible brand signal in:

- Login screen.
- Main navigation/header.

The color system should follow the logo:

- Deep seminary red for primary buttons and important accents.
- Gold for highlights, borders, totals, and selected states.
- Flame orange as a supporting accent for progress/storage.
- Warm cream backgrounds for a softer library feel.
- Dark brown/ink text for readability.

The interface should remain practical and readable for admin work. The branding should support the library experience without making dashboards crowded.

## 4. Authentication Plan

The app supports:

- Email/password login.
- Admin bootstrap login through environment variables.
- Google sign-in if Google OAuth variables are configured.

Secrets must be kept only in Vercel environment variables. They must never be committed to GitHub or placed in frontend code.

Required authentication-related variables:

```text
ADMIN_EMAIL
ADMIN_BOOTSTRAP_PASSWORD
SESSION_SECRET
BASE_URL
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_REDIRECT_URI
```

Google sign-in is currently optional and depends on OAuth setup.

## 5. Library Departments

Default departments:

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
  - English
  - Greek
  - Hebrew
- Research Methodology
- Music
- Homiletics
- Pastoral Care and Counselling

Admins can add more categories from the admin dashboard.

## 6. Upload Plan

Admins can upload:

- One file.
- Many selected files.
- A whole folder.
- A ZIP archive.

Supported formats:

- PDF
- EPUB
ZIP files may be selected, but only PDF and EPUB files inside the ZIP are imported.

Upload modes:

- Auto-categorize by filename and folder path.
- Manual category for the whole upload.

Current upload behavior:

- Each supported file is treated as an e-book resource.
- Uploads are automatically published.
- No publish button is required.
- Exact duplicate PDF/EPUB files are skipped by file hash.
- Similar filename or similar file size alone does not skip a book.
- Files are skipped only when they are not PDF/EPUB.
- Book count updates after upload.
- Storage usage updates after upload.

## 7. Large Upload Plan

Large uploads should work like this:

1. The browser sends each large file in smaller internal upload steps.
2. Vercel receives temporary chunks only while the file is being completed.
3. The completed file is saved to AWS S3 as one complete object.
4. The app creates one resource record for that file.
5. The student sees one book, not upload parts.
6. The active upload receives a temporary 12-hour upload token, so the batch does not collapse into repeated `Login required` failures if the normal browser cookie is not recognized during a later request.

ZIP behavior:

1. The ZIP is opened in the browser.
2. Each supported PDF/EPUB inside the ZIP is extracted by the browser.
3. Each extracted file is uploaded as its own complete library item.
4. JPG/PNG/WEBP/GIF and other unsupported files inside the ZIP are skipped.

Why this matters:

Vercel cannot be used as permanent storage and cannot hold many large uploaded files in temporary disk. Large uploads previously failed when Vercel temp storage filled up. The current plan avoids that by saving final files directly to AWS S3.

Recommended admin practice:

- Upload in sensible batches.
- Keep the browser tab open during upload.
- Use the upload stop button if a wrong folder/file was selected.
- Use the clear selected files button before upload if the wrong file was chosen.
- Check the upload log only for unsupported file type messages during upload.
- Check storage left after each major batch.

## 8. Duplicate Handling

The app stores a file hash and uses it to skip only exact duplicate PDF/EPUB files.

If the exact same file already exists:

- The duplicate PDF/EPUB is skipped.
- The upload log shows the duplicate reason.

If only the filename or size looks similar:

- The PDF/EPUB is still added.
- Admins can later remove unwanted copies manually if needed.
- Unsupported JPG/PNG/WEBP/GIF and other files are still skipped.

This keeps the student library clean and avoids repeated book entries.

## 9. Classification And Bibliography Plan

Every uploaded e-book should receive:

- Dewey Decimal-style number.
- Dewey class label.
- Call number.
- Title.
- Author when safely detected.
- Department/category.
- Format.
- Original filename.
- Confidence level.
- Bibliography entry.

Classification is automatic and advisory. It uses:

- Selected category.
- Folder path.
- Filename.
- Known department keywords.
- Bible book and theological subject keywords.

Admins can correct title/category after upload. When classification exports are downloaded, bibliography details are rebuilt from the current record so older records can still export correctly after improvements.

Export formats:

- HTML
- Word-compatible DOC
- Excel-compatible XLS
- CSV
- PDF

## 10. Student Library Plan

Student library behavior:

- Do not show all uploaded books by default.
- Show books when the student searches or chooses a category.
- Search should accept any word.
- Category is optional.
- Results appear in list/table form.
- Student opens books through a protected reader route.
- Admins/directors viewing the Library page can change a listed book's category directly from the search result row.

Search should include:

- Title.
- Author.
- Original filename.
- Category.
- Format.
- Dewey number.
- Dewey class.
- Bibliography text.

## 11. File Viewing Plan

Files are served through protected routes.

Current behavior:

- App does not show ordinary download buttons.
- Raw AWS object URLs are not public.
- Admin/student must be authenticated to view a protected file.
- Students cannot access unpublished or removed resources.

Limitation:

No web app can fully prevent screenshots, screen recording, or browser-level copying. The app blocks ordinary public download exposure but cannot control the user's device.

## 12. Tracking Plan

The app records:

- Login sessions.
- Logout/session end when available.
- Resource opened.
- Reading session start.
- Reading session end.
- Category accessed.
- Total reading duration.

Admin reports show:

- Student name/email.
- Number of logins.
- Number of books opened.
- Reading hours.

Students cannot view other students' history.

## 13. Storage Plan

AWS S3 is the production storage system.

S3 layout:

```text
agbs-library/
  books/
    one complete object per PDF/EPUB
  data/
    users.json
    categories.json
    resources.json
    uploadBatches.json
    loginSessions.json
    readingSessions.json
    accessEvents.json
    skippedUploads.json
  tmp/uploads/
    temporary upload chunks
```

Storage dashboard:

- Shows total storage left.
- Shows estimated month runway.
- Uses a 12-month planning view.
- Current planning budget target is 3000 GB unless changed by environment variable.

Storage-related environment variables:

```text
AWS_REGION
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
AWS_S3_BUCKET
AWS_S3_PREFIX
AWS_STORAGE_BUDGET_GB
AWS_STORAGE_PLAN_MONTHS
```

## 14. Environment Variables

Set in Vercel Project Settings:

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

Never commit real values for these variables.

## 15. Current Verified Behavior

Recently verified:

- Live site loads.
- AWS S3 configuration is active.
- Admin login works.
- Test upload to AWS succeeded.
- Test file was removed after verification.
- HTML classification export works.
- Word-compatible classification export works.
- Catalog export includes call number and book classification details.
- No new 500 errors after the latest upload/export fix.

Current live book count at last verification: 150.

## 16. Known Limitations

- Very large uploads still depend on browser stability and network reliability.
- The browser tab should stay open during upload.
- Serverless APIs are not ideal for extremely heavy background jobs.
- EPUB page/location tracking is basic compared with a dedicated EPUB reader library.
- Google login will only work after Google OAuth credentials are configured.
- JSON records in S3 are acceptable for the current small admin/student workflow, but a proper database may be needed later if usage becomes very large or multi-admin editing becomes frequent.

## 17. Future Improvement Plan

Recommended next improvements:

1. Add a durable background queue for very large library imports.
2. Add upload resume across page refreshes.
3. Add deeper PDF page tracking and EPUB location tracking.
4. Add admin report exports for student history.
5. Add stronger metadata extraction from PDF/EPUB files.
6. Add manual bibliography editing fields.
7. Add a true database if many admins edit records at the same time.
8. Configure Google OAuth for Gmail sign-in.
9. Add cloud monitoring alerts for failed uploads.
10. Add automatic cleanup for old temporary upload chunks.

## 18. Safe Continuation Rules

When continuing this project:

- Do not expose passwords, tokens, API keys, or AWS secrets.
- Keep all secrets in Vercel environment variables.
- Keep student uploads disabled.
- Keep admin routes protected server-side.
- Keep AWS S3 as the production storage system.
- Do not reintroduce R2 or MongoDB unless a deliberate migration is planned.
- Test upload, view, replace, remove, export, and student reading after major changes.
- Push confirmed changes to GitHub.
- Deploy to Vercel after code changes.

## 19. Quick Test Checklist

Before saying a deployment is ready:

- `/api/config` shows AWS storage active.
- Admin can sign in.
- Admin can upload a small test file.
- Test file appears in admin recent books.
- Test file can be viewed through protected route.
- Test file can be removed.
- Student search does not show all books until search/category is used.
- Exact duplicate PDF/EPUB upload is skipped.
- Same-name but different-content PDF/EPUB upload is added.
- HTML export downloads.
- Word export downloads.
- Storage panel loads.
- No recent production 500 errors appear in Vercel logs.
