// NOTE: There are persistent `no-undef` errors for `onCall`, `HttpsError`, and `onRequest`
// from 'firebase-functions/v2/https' during the linting phase of Firebase deployment.
// The import statement appears correct in the code. This issue is suspected to be external,
// possibly related to dependency caching or corruption in the Firebase build environment.
// Manual steps like cleaning dependencies (`npm install`) might be needed to resolve this.
// functions/index.js
'use strict';

// Add a log at the very beginning to confirm the file is being loaded by Firebase Functions runtime
console.log('[Firebase Functions] index.js: File loading initiated by Functions runtime...');

import * as admin from 'firebase-admin'; // Keep for admin.firestore.FieldValue
import { initializeApp, getApps } from 'firebase-admin/app'; // Import initializeApp and getApps from app
import { getFirestore } from 'firebase-admin/firestore'; // Import getFirestore
import { getAuth } from 'firebase-admin/auth'; // Import getAuth
import { onCall, onRequest, HttpsError } from 'firebase-functions/v2/https';
import * as logger from 'firebase-functions/logger'; // Using v2 logger
import * as crypto from 'crypto';
import * as SibApiV3Sdk from '@sendinblue/client';

// Determine Brevo configuration
// For Gen 2 functions, environment variables set via `firebase functions:config:set`
// or directly in GCP Console are accessed via process.env.
// For Gen 1 functions (if functions.config() is used), they are accessed via functions.config().
// This setup attempts to be compatible with both by prioritizing process.env.
const brevoApiKeyFromEnv = process.env.BREVO_API_KEY;
const brevoSenderEmailFromEnv = process.env.BREVO_SENDER_EMAIL || 'info@bergmantri.com';
const brevoSenderNameFromEnv = process.env.BREVO_SENDER_NAME || 'Bergman Triathlon';
const brevoOtpTemplateIdFromEnv = process.env.BREVO_OTP_TEMPLATE_ID || '178'; // Defaulting to 178

const brevoConfig = {
  apiKey: brevoApiKeyFromEnv,
  senderEmail: brevoSenderEmailFromEnv,
  senderName: brevoSenderNameFromEnv,
  otpTemplateId: parseInt(brevoOtpTemplateIdFromEnv, 10), // Ensure it's an integer
};

logger.info('[Firebase Functions] Brevo Config Loaded:', {
  apiKeyExists: !!brevoConfig.apiKey,
  senderEmail: brevoConfig.senderEmail,
  senderName: brevoConfig.senderName,
  otpTemplateIdParsed: brevoConfig.otpTemplateId,
  sourceApiKey: process.env.BREVO_API_KEY ? 'process.env' : 'Not Found',
  sourceTemplateId: process.env.BREVO_OTP_TEMPLATE_ID ? 'process.env' : `Defaulted to ${brevoOtpTemplateIdFromEnv}`,
});


let db;
let authAdmin;
// Initialize Firebase Admin SDK only once
if (!getApps().length) {
  try { // Use initializeApp() without admin prefix
    initializeApp(); // Initialize the default app
    db = getFirestore(); // Get Firestore instance from the default app
    authAdmin = getAuth(); // Get Auth instance from the default app
    logger.info('[Firebase Functions] Admin SDK initialized by Functions runtime.');
  } catch (e) {
    logger.error('[Firebase Functions] CRITICAL: Admin SDK initialization failed:', e);
    // If admin SDK fails, functions dependent on it will likely fail.
  }
} else {
  logger.info('[Firebase Functions] Admin SDK already initialized.');
}


const OTP_LENGTH = 6;
const OTP_EXPIRY_MINUTES = 10;
const OTP_COLLECTION = 'otp_attempts';
const OTP_RESEND_COOLDOWN_SECONDS = 60;

const FUNCTION_OPTIONS = {
  region: 'us-central1',
  serviceAccount: '951167443377-compute@developer.gserviceaccount.com', // Or your preferred service account
  // memory: '256MiB', // Example, Gen 2 allows more direct configuration here
  // timeoutSeconds: 60, // Example
};

function generateOtp() {
  return crypto.randomInt(10 ** (OTP_LENGTH - 1), 10 ** OTP_LENGTH - 1).toString();
}

function hashOtp(otp) {
  return crypto.createHash('sha256').update(otp).digest('hex');
}

function maskEmail(email) {
  if (!email || typeof email !== 'string') return 'invalid_email_format';
  const parts = email.split('@');
  if (parts.length !== 2) return 'incomplete_email';
  const localPart = parts[0];
  const domainPart = parts[1];
  // Show first char, then ***, then @domain. Ensure localPart has at least 1 char.
  return `${localPart.substring(0, Math.min(1, localPart.length))}***@${domainPart}`;
}


const brevoClient = brevoConfig.apiKey ? new SibApiV3Sdk.TransactionalEmailsApi() : null;
if (brevoClient && brevoConfig.apiKey) {
  brevoClient.setApiKey(SibApiV3Sdk.TransactionalEmailsApiApiKeys.apiKey, brevoConfig.apiKey);
  logger.info('[Firebase Functions] Brevo client initialized with API key.');
} else {
  logger.warn('[Firebase Functions] Brevo API key not found. Brevo client not initialized. OTP emails will not be sent.');
}

/**
 * @summary Sends an OTP to the user's email and stores its hash in Firestore.
 * @param {object} request - The request object.
 * @param {string} request.data.email - The user's email address.
 * @return {Promise<{success: boolean, message: string}>} A promise that resolves with the operation result.\n */
export const sendAndStoreOtp = onCall(FUNCTION_OPTIONS, async (request) => {
  const { email } = request.data;
  const lowerCaseEmail = email ? String(email).toLowerCase() : null;
  const maskedEmail = maskEmail(lowerCaseEmail);
  logger.info(`[sendAndStoreOtp] Received request for email: ${maskedEmail}`);

  if (!lowerCaseEmail) {
    logger.error('[sendAndStoreOtp] Email is required.');
    throw new HttpsError('invalid-argument', 'Email is required.');
  }
  if (!brevoClient) {
    logger.error('[sendAndStoreOtp] Brevo client not initialized (API key missing). Cannot send OTP.');
    throw new HttpsError('failed-precondition', 'OTP service is temporarily unavailable. Please try again later. (Brevo Init Error)');
  }
  if (isNaN(brevoConfig.otpTemplateId) || brevoConfig.otpTemplateId <= 0) {
    logger.error(`[sendAndStoreOtp] Invalid or missing Brevo OTP Template ID: ${brevoConfig.otpTemplateId}`);
    throw new HttpsError('failed-precondition', 'OTP service configuration error (Template ID).');
  }

  try {
    const otpDocRef = db.collection(OTP_COLLECTION).doc(lowerCaseEmail);
    const recentOtpDoc = await otpDocRef.get();

    if (recentOtpDoc.exists && recentOtpDoc.data().createdAt) {
      const lastCreated = recentOtpDoc.data().createdAt.toDate();
      const diffMs = Date.now() - lastCreated.getTime();
      if (diffMs < OTP_RESEND_COOLDOWN_SECONDS * 1000) {
        const timeLeft = Math.ceil((OTP_RESEND_COOLDOWN_SECONDS * 1000 - diffMs) / 1000);
        logger.warn(`[sendAndStoreOtp] OTP request for ${maskedEmail} too soon. Cooldown: ${timeLeft}s remaining.`);
        throw new HttpsError('resource-exhausted', `Please wait ${timeLeft} seconds before requesting another OTP.`);
      }
    }

    const plainOtp = generateOtp();
    const hashedOtp = hashOtp(plainOtp);
    const expiryDate = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

    // Log OTP details for debugging (consider removing plainOtp logging in production)
    logger.info(`[sendAndStoreOtp] Generated OTP for ${maskedEmail}. Hashed OTP: ${hashedOtp.substring(0,10)}... Expiry: ${expiryDate.toISOString()}`);

    await otpDocRef.set({
      otpHash: hashedOtp,
      expiresAt: admin.firestore.Timestamp.fromDate(expiryDate),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      verified: false, // Reset verification status
    });
    logger.info(`[sendAndStoreOtp] OTP hash stored for ${maskedEmail}. Email sending initiated.`);

     
    const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
    sendSmtpEmail.templateId = brevoConfig.otpTemplateId;
    sendSmtpEmail.to = [{ email: lowerCaseEmail }];
    sendSmtpEmail.params = { otp: plainOtp }; // Ensure Brevo template uses {{ params.otp }}
    sendSmtpEmail.sender = { email: brevoConfig.senderEmail, name: brevoConfig.senderName };

    let brevoResponseData = null;
    try {
      logger.info(`[sendAndStoreOtp] Attempting to send OTP email to ${maskedEmail} via Brevo (Template ID: ${brevoConfig.otpTemplateId}). Params: {otp: '****'}`);
      const brevoApiResponse = await brevoClient.sendTransacEmail(sendSmtpEmail);
      brevoResponseData = brevoApiResponse.body; // Brevo SDK v3 response structure
      logger.info(`[sendAndStoreOtp] Brevo API full response for ${maskedEmail}:`, JSON.stringify(brevoResponseData));
      if (brevoApiResponse.response.statusCode < 200 || brevoApiResponse.response.statusCode >= 300) {
        // Ensure the error object structure is helpful for logging
        const brevoError = new Error(`Brevo API Error: Status ${brevoApiResponse.response.statusCode} - ${JSON.stringify(brevoResponseData)}`);
        brevoError.response = brevoApiResponse.response; // Attach response for more context if needed
        throw brevoError;
      }
    } catch (emailErr) {
      logger.error(`[sendAndStoreOtp] Failed to send email to ${maskedEmail} via Brevo. Error:`, {
        message: emailErr && emailErr.message ? emailErr.message : 'Unknown error',
        stack: emailErr instanceof Error ? emailErr.stack : undefined,
        responseBody: emailErr && emailErr.response && emailErr.response.body ? JSON.stringify(emailErr.response.body) : 'N/A',
      });
      throw new HttpsError('internal', 'Failed to send OTP email due to a provider issue. Please try again.');
    }

    const successMsg = `[sendAndStoreOtp] OTP successfully sent to ${maskedEmail}. Brevo Message ID (if available): ${brevoResponseData?.messageId || 'N/A'}`;
    logger.info(successMsg);

    return {
      success: true,
      message: 'OTP sent successfully. Please check your email.',
    };
  } catch (err) {
    if (err instanceof HttpsError) {
      logger.warn(`[sendAndStoreOtp] HttpsError for ${maskedEmail}:`, { code: err.code, message: err.message });
      throw err;
    }
    logger.error(`[sendAndStoreOtp] Unexpected error while processing OTP for ${maskedEmail}:`, {
      message: err && err.message ? err.message : 'Unknown error',
      stack: err instanceof Error ? err.stack : undefined,
      responseBody: err && err.response && err.response.body
 ? JSON.stringify(err.response.body)
        : 'N/A',
    });
 throw new HttpsError('internal', 'Failed to send OTP. Please try again later.');
}
});


/**
 * @summary Verifies an OTP and creates a Firebase custom token if valid.
 * @param {object} request - The request object.
 * @param {string} request.data.email - The user's email address.
 * @param {string} request.data.otp - The OTP entered by the user.
 * @return {Promise<{success: boolean, message: string, token?: string, uid?: string}>} Result.\n */
export const verifyOtpAndCreateCustomToken = onCall(FUNCTION_OPTIONS, async (request) => {
  const { email, otp } = request.data;
  const lowerCaseEmail = email ? String(email).toLowerCase() : null;
  const maskedEmail = maskEmail(lowerCaseEmail);
  logger.info(`[verifyOtpAndCreateCustomToken] Received OTP verification request for email: ${maskedEmail}`);

  if (!lowerCaseEmail || !otp) {
    logger.error('[verifyOtpAndCreateCustomToken] Email and OTP are required.');
    throw new HttpsError('invalid-argument', 'Email and OTP are required.');
  }

  try {
    const otpDocRef = db.collection(OTP_COLLECTION).doc(lowerCaseEmail);
    const otpDoc = await otpDocRef.get();

    if (!otpDoc.exists) {
      logger.warn(`[verifyOtpAndCreateCustomToken] OTP entry not found for ${maskedEmail}.`);
      throw new HttpsError('not-found', 'OTP not found or already used. Please request a new one.');
    }

    const otpData = otpDoc.data();
    const { otpHash: storedOtpHash, expiresAt, verified } = otpData;

    if (verified && expiresAt.toDate() >= new Date()) {
        logger.warn(`[verifyOtpAndCreateCustomToken] OTP for ${maskedEmail} was already verified but not yet expired. Treating as used.`);
        throw new HttpsError('already-exists', 'This OTP has already been used. Please request a new one.');
    }
    if (expiresAt.toDate() < new Date()) {
      logger.warn(`[verifyOtpAndCreateCustomToken] OTP expired for ${maskedEmail}. Deleting entry.`);
      await otpDocRef.delete();
      throw new HttpsError('deadline-exceeded', 'OTP has expired. Please request a new one.');
    }

    const submittedOtpHash = hashOtp(otp);
    if (storedOtpHash !== submittedOtpHash) {
      logger.warn(`[verifyOtpAndCreateCustomToken] Incorrect OTP entered for ${maskedEmail}.`);
      // Optionally, implement attempt tracking here to lock out after too many failures
      throw new HttpsError('invalid-argument', 'Incorrect OTP entered.');
    }

    // Mark OTP as verified in Firestore before creating token
    await otpDocRef.update({ verified: true, verifiedAt: admin.firestore.FieldValue.serverTimestamp() });
    logger.info(`[verifyOtpAndCreateCustomToken] OTP for ${maskedEmail} marked as verified.`);

    let userRecord;
    try {
      userRecord = await authAdmin.getUserByEmail(lowerCaseEmail);
      logger.info(`[verifyOtpAndCreateCustomToken] Existing user found for ${maskedEmail}: UID ${userRecord.uid}`);
    } catch (error) {
      if (error && error.code === 'auth/user-not-found') {
        logger.info(`[verifyOtpAndCreateCustomToken] User not found for ${maskedEmail}. Creating new user.`);
        try {
          userRecord = await authAdmin.createUser({
            email: lowerCaseEmail,
            emailVerified: true, // Email is verified by OTP process
            // No password for OTP-only users initially. They can set one later if desired.
          });
          logger.info(`[verifyOtpAndCreateCustomToken] New Firebase Auth user created for ${maskedEmail}: UID ${userRecord.uid}`);

          // Create a basic profile in 'users' collection for the new Auth user
          const userProfile = {
            uid: userRecord.uid,
            email: lowerCaseEmail,
            name: null, // To be filled by user during profile completion
            mobile: null,
            photoURL: null,
            // Initialize club fields to null
            ownedClubId: null,
            ownedClubName: null,
            ownedClubLogoUrl: null,
            ownedClubInstagramUrl: null,
            ownedClubFacebookUrl: null,
            clubId: null,
            clubName: null,
            clubAffiliationDate: null,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          };
          await db.collection('users').doc(userRecord.uid).set(userProfile);
          logger.info(`[verifyOtpAndCreateCustomToken] Basic profile created in Firestore for new user ${userRecord.uid}.`);

        } catch (createUserError) {
          logger.error(`[verifyOtpAndCreateCustomToken] Error creating new Firebase Auth user for ${maskedEmail}:`, { message: createUserError && createUserError.message ? createUserError.message : 'Unknown error', stack: createUserError instanceof Error ? createUserError.stack : undefined });
          await otpDocRef.update({ verified: false, verifiedAt: null }); // Rollback verification status
          throw new HttpsError('internal', 'Failed to create user account after OTP verification.');
        }
      } else {
        logger.error(`[verifyOtpAndCreateCustomToken] Error fetching user by email ${maskedEmail}:`, { message: error.message, stack: error.stack });
        await otpDocRef.update({ verified: false, verifiedAt: null }); // Rollback verification status
        throw new HttpsError('internal', 'Error verifying user status.');
      }
    }

    const customToken = await authAdmin.createCustomToken(userRecord.uid);
    logger.info(`[verifyOtpAndCreateCustomToken] Custom token created for UID ${userRecord.uid} (${maskedEmail}).`);

    // Delete OTP document after successful token generation
    await otpDocRef.delete();
    logger.info(`[verifyOtpAndCreateCustomToken] OTP document deleted for ${maskedEmail} after successful verification.`);

    return {
      success: true,
      message: 'OTP verified successfully.',
      token: customToken,
      uid: userRecord.uid,
    };
  } catch (err) {
    if (err instanceof HttpsError) {
      logger.warn(`[verifyOtpAndCreateCustomToken] HttpsError for ${maskedEmail}:`, { code: err.code, message: err.message });
      throw err;
    }
    logger.error(`[verifyOtpAndCreateCustomToken] Unexpected error during OTP verification for ${maskedEmail}:`, { message: err && err.message ? err.message : 'Unknown error', stack: err instanceof Error ? err.stack : undefined });
    throw new HttpsError('internal', 'Failed to verify OTP. Please try again later.');
  }
});


/**
 * @summary Placeholder for updating user data in Firestore (typically via Admin SDK for privileged operations).
 * For client-side profile updates directly to Firestore, ensure Firestore security rules are in place.
 * Actual profile updates are handled by Next.js Server Actions using Admin SDK.
 * @param {object} request - The request object.
 * @param {string} request.data.uid - The user's UID.
 * @param {object} request.data.profileData - The profile data to update.
 * @return {Promise<{success: boolean, message: string}>} A promise that resolves with the operation result.\n */
export const updateUser = onCall(FUNCTION_OPTIONS, async (request) => {
  const { uid, profileData } = request.data;
  logger.info(`[updateUser Firebase Function] Called for UID: ${uid} with data:`, profileData);

  logger.warn('[updateUser Firebase Function] This function is a placeholder and does not perform profile updates. See src/lib/actions/userActions.ts for actual profile update logic using Server Actions.');
  return {
    success: false,
    message: 'updateUser Firebase Function is a placeholder and not actively used for profile updates. See server actions.',
  };
});

logger.info('[Firebase Functions] index.js successfully loaded and all exportable functions defined (or placeholders set).');

// Add a new exported 2nd Gen HTTP function to check the Brevo API key
export const checkBrevoKey = onRequest((req, res) => {
  const brevoApiKey = process.env.BREVO_API_KEY;
  logger.info("Brevo API Key Exists:", !!brevoApiKey);
  res.send({ brevoApiKeyExists: !!brevoApiKey });
});