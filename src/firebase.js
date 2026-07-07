// ─── FIREBASE ─────────────────────────────────────────────────────────────
// Config values here are NOT secret — they identify the project, not a
// credential. Access is actually controlled by the Firestore security rules
// (see FIREBASE_SETUP.md), so it's fine that this file ships to the browser.
import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyBF1wy780toM--A7lno8ioN4w5gqDQzfNM",
  authDomain: "inflow-tracker.firebaseapp.com",
  projectId: "inflow-tracker",
  storageBucket: "inflow-tracker.firebasestorage.app",
  messagingSenderId: "730978035364",
  appId: "1:730978035364:web:d86fa6b8e0cd6c3a4ee831",
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const googleProvider = new GoogleAuthProvider();
