// ─── FIREBASE ─────────────────────────────────────────────────────────────
// Config values here are NOT secret — they identify the project, not a
// credential. Access is actually controlled by the Firestore security rules
// (see FIREBASE_SETUP.md), so it's fine that this file ships to the browser.
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyA8Hd6F9oinSOVmwmj3AYwfDfSd4ilm664",
  authDomain: "inflow-tracker-d4cc0.firebaseapp.com",
  projectId: "inflow-tracker-d4cc0",
  storageBucket: "inflow-tracker-d4cc0.firebasestorage.app",
  messagingSenderId: "449019882248",
  appId: "1:449019882248:web:cbe523e01b624e36b09abd",
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
