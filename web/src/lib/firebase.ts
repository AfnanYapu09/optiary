import { initializeApp, getApps, getApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  type User as FirebaseUser,
} from "firebase/auth";
import {
  getFirestore,
  doc,
  getDocFromServer,
  getDoc,
  setDoc,
} from "firebase/firestore";
import firebaseConfig from "../firebase-applet-config.json";

export const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

/* CRITICAL: The app will break without specifying the firestoreDatabaseId */
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: "select_account" });

export enum OperationType {
  CREATE = "create",
  UPDATE = "update",
  DELETE = "delete",
  LIST = "list",
  GET = "get",
  WRITE = "write",
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error("Firestore Error: ", JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// Test connection on boot as mandated
export async function testConnection(): Promise<boolean> {
  try {
    await getDocFromServer(doc(db, "test", "connection"));
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes("the client is offline")) {
      console.warn("Firestore connection check: client is offline");
      return false;
    }
    // Expected permission error or missing document is fine for connection validation
    return true;
  }
}

// Run test connection
void testConnection();

export async function signInWithGoogle(): Promise<FirebaseUser | null> {
  try {
    const result = await signInWithPopup(auth, googleProvider);
    return result.user;
  } catch (err: any) {
    if (
      err?.code === "auth/popup-closed-by-user" ||
      err?.code === "auth/cancelled-popup-request" ||
      err?.message?.includes("popup-closed-by-user")
    ) {
      // User closed the popup window or cancelled login flow
      return null;
    }
    console.warn("Google Sign-In notice:", err?.message || err);
    throw err;
  }
}

export async function signOutFirebase(): Promise<void> {
  await firebaseSignOut(auth);
}

export { onAuthStateChanged };
export type { FirebaseUser };

/**
 * Online Cloud Storage: Sync and Persist Entry to Cloud Firestore
 */
export async function syncEntryToCloud(
  _userId: string,
  date: string,
  slot: string,
  data: { note?: string; tags?: string[]; metrics?: any },
): Promise<void> {
  const currentFbUser = auth.currentUser;
  if (!currentFbUser) return;
  const targetUid = currentFbUser.uid;
  const entryId = `${date}_${slot}`;
  const path = `users/${targetUid}/entries/${entryId}`;
  try {
    const docRef = doc(db, "users", targetUid, "entries", entryId);
    await setDoc(
      docRef,
      {
        userId: targetUid,
        date,
        slot,
        note: data.note ?? "",
        tags: data.tags ?? [],
        metrics: data.metrics ?? null,
        updatedAt: new Date().toISOString(),
      },
      { merge: true },
    );
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

/**
 * Online Cloud Storage: Save Chat Message to Cloud Firestore
 */
export async function saveChatMessageToCloud(
  _userId: string,
  role: "user" | "assistant",
  content: string,
): Promise<void> {
  const currentFbUser = auth.currentUser;
  if (!currentFbUser) return;
  const targetUid = currentFbUser.uid;
  const messageId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const path = `users/${targetUid}/messages/${messageId}`;
  try {
    const docRef = doc(db, "users", targetUid, "messages", messageId);
    await setDoc(docRef, {
      userId: targetUid,
      role,
      content,
      createdAt: new Date().toISOString(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

/**
 * Online Cloud Storage: Save User Profile to Cloud Firestore
 */
export async function saveUserProfileToCloud(user: {
  id?: string;
  email: string;
  name: string;
  settings?: any;
}): Promise<void> {
  const currentFbUser = auth.currentUser;
  if (!currentFbUser) return;
  const targetUid = currentFbUser.uid;
  const path = `users/${targetUid}`;
  try {
    const docRef = doc(db, "users", targetUid);
    const existing = await getDoc(docRef);
    const now = new Date().toISOString();
    if (!existing.exists()) {
      await setDoc(docRef, {
        userId: targetUid,
        email: user.email || currentFbUser.email || "",
        name: user.name || currentFbUser.displayName || "Trader",
        settings: user.settings ?? {},
        createdAt: now,
        updatedAt: now,
      });
    } else {
      await setDoc(
        docRef,
        {
          name: user.name || currentFbUser.displayName || "Trader",
          settings: user.settings ?? {},
          updatedAt: now,
        },
        { merge: true },
      );
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}
