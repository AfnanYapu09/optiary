import { initializeApp, getApps, getApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  type User as FirebaseUser,
} from "firebase/auth";
import firebaseConfig from "../firebase-applet-config.json";

export const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

/**
 * Firestore is loaded on demand rather than at module scope. Auth has to be
 * present on every page load (the session is resolved before anything renders),
 * but Firestore is only touched by the background cloud-sync writes — so
 * shipping it in the entry chunk made every first paint wait on code that most
 * sessions never reach. `import()` puts it in its own chunk instead.
 *
 * CRITICAL: the app breaks without passing firestoreDatabaseId.
 */
let firestore: Promise<{
  db: import("firebase/firestore").Firestore;
  doc: typeof import("firebase/firestore").doc;
  getDoc: typeof import("firebase/firestore").getDoc;
  getDocFromServer: typeof import("firebase/firestore").getDocFromServer;
  setDoc: typeof import("firebase/firestore").setDoc;
}> | null = null;

function loadFirestore() {
  if (!firestore) {
    firestore = import("firebase/firestore").then((m) => ({
      db: m.getFirestore(app, firebaseConfig.firestoreDatabaseId),
      doc: m.doc,
      getDoc: m.getDoc,
      getDocFromServer: m.getDocFromServer,
      setDoc: m.setDoc,
    }));
  }
  return firestore;
}

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

/**
 * Reachability probe for Firestore. Deliberately NOT run at module scope any
 * more: doing so pulled the Firestore chunk into every page load purely to log
 * a warning, which is the cost this lazy split exists to avoid. Nothing ever
 * consumed its result — it returns true even on a permission error — so it is
 * now only called if something asks.
 */
export async function testConnection(): Promise<boolean> {
  try {
    const fs = await loadFirestore();
    await fs.getDocFromServer(fs.doc(fs.db, "test", "connection"));
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
    const fs_ = await loadFirestore();
    const docRef = fs_.doc(fs_.db, "users", targetUid, "entries", entryId);
    await fs_.setDoc(
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
    const fs_ = await loadFirestore();
    const docRef = fs_.doc(fs_.db, "users", targetUid, "messages", messageId);
    await fs_.setDoc(docRef, {
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
    const fs_ = await loadFirestore();
    const docRef = fs_.doc(fs_.db, "users", targetUid);
    const existing = await fs_.getDoc(docRef);
    const now = new Date().toISOString();
    if (!existing.exists()) {
      await fs_.setDoc(docRef, {
        userId: targetUid,
        email: user.email || currentFbUser.email || "",
        name: user.name || currentFbUser.displayName || "Trader",
        settings: user.settings ?? {},
        createdAt: now,
        updatedAt: now,
      });
    } else {
      await fs_.setDoc(
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
