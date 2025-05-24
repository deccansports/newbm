
# Firebase Storage Security Rules

This document outlines recommended Firebase Storage security rules, primarily for user profile pictures and club logos.

```javascript
rules_version = '2';

service firebase.storage {
  match /b/{bucket}/o { // Matches all files in the bucket

    // === User Profile Pictures ===
    // Path: profilePictures/{userId}/{fileName}
    // Example: profilePictures/USER_UID_HERE/profile.jpg
    match /profilePictures/{userId}/{fileName} {

      // Allow authenticated users to read their own profile picture(s).
      allow read: if request.auth != null && request.auth.uid == userId;

      // Allow authenticated users to write (upload, update, delete)
      // their own profile picture(s).
      allow write: if request.auth != null && request.auth.uid == userId
                    // Optional: Restrict file type (e.g., only images)
                    && request.resource.contentType.matches('image/.*')
                    // Optional: Restrict file size (e.g., max 500KB for user profiles)
                    && request.resource.size < 500 * 1024; // 500KB limit
    }

    // === Club Logos ===
    // Path: club-logos/{clubId}/{fileName}
    // Example: club-logos/YOUR_CLUB_DOCUMENT_ID_HERE/logo.jpg
    match /club-logos/{clubId}/{fileName} {
      // Allow public read access to club logos
      allow read: if true;

      // Allow write (upload, update, delete) only if the requester is the owner of the club.
      // This rule requires fetching the club document from Firestore to verify ownership.
      // Ensure your Firestore rules allow reading /clubs/{clubId} for authenticated users.
      allow write: if request.auth != null &&
                   // Get the club document from Firestore
                   get(/databases/$(database)/documents/clubs/$(clubId)).data.ownerUid == request.auth.uid
                   // Optional: Restrict file type (e.g., only images)
                   && request.resource.contentType.matches('image/.*')
                   // Optional: Restrict file size (e.g., max 1MB for club logos)
                   && request.resource.size < 1 * 1024 * 1024; // 1MB limit
    }

    // Add rules for other storage paths as needed.
    // Example: Publicly readable assets in a 'public_assets' folder
    // match /public_assets/{allPaths=**} {
    //   allow read: if true;
    //   allow write: if false; // Or restrict to admin
    // }
  }
}
```

**Explanation of Rules:**

*   **`service firebase.storage`**: Defines rules for Firebase Storage.
*   **`match /b/{bucket}/o`**: Matches all objects in any bucket in your project.

*   **`match /profilePictures/{userId}/{fileName}`**:
    *   Targets files under `profilePictures/some_user_id/some_file_name.jpg`.
    *   **`allow read: if request.auth != null && request.auth.uid == userId;`**: An authenticated user can read their own profile picture.
    *   **`allow write: if request.auth != null && request.auth.uid == userId ...;`**: An authenticated user can write to their own profile picture path, with optional checks for image content type (only images) and size (500KB limit).

*   **`match /club-logos/{clubId}/{fileName}`**:
    *   Targets files under `club-logos/some_club_document_id/some_logo_file.jpg`.
    *   **`allow read: if true;`**: Makes club logos publicly readable, which is common.
    *   **`allow write: if request.auth != null && get(/databases/$(database)/documents/clubs/$(clubId)).data.ownerUid == request.auth.uid ...;`**:
        *   Allows write operations only if the authenticated user (`request.auth.uid`) is the `ownerUid` of the club document (fetched from Firestore `/clubs/{clubId}`).
        *   This requires that your Firestore security rules allow an authenticated user to read the specific club document. The rule `match /clubs/{clubId} { allow read: if request.auth != null; }` in your Firestore rules is sufficient for this `get()` call to succeed when the Storage request is made by an authenticated user.
        *   Includes optional checks for image content type (only images) and size (1MB limit for club logos).

**Important Considerations:**

*   **File Naming Convention:** The client application should be responsible for uploading files to the correct path (e.g., using the authenticated user's UID for profile pictures, or the club's Firestore document ID for club logos).
*   **Firestore Read Access for Storage Rules:** For the club logo write rule to work, the Firebase Storage service (acting on behalf of the authenticated user) needs to be able to read the `/clubs/{clubId}` document from Firestore. Ensure your Firestore rules permit this for authenticated users.
*   **Admin Access:** If administrators (not just club owners) need to manage these images, you would add rules based on custom claims or a separate admin role check.
*   **Testing:** Always test your Storage security rules thoroughly using the Firebase Emulator Suite or the Rules Playground in the Firebase Console.


```