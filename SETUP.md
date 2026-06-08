# SurveyTrack — Firebase Setup Guide

This version connects to **Firebase Firestore** so all data is shared across devices in real time.

---

## Step 1 — Create a Firebase project

1. Go to **[https://console.firebase.google.com](https://console.firebase.google.com)**
2. Sign in with your Google account
3. Click **"Add project"**
4. Give it a name (e.g. `surveytrack`) → click **Continue**
5. You can disable Google Analytics if you don't need it → click **Create project**
6. Wait a few seconds, then click **Continue**

---

## Step 2 — Register a Web App and get your config keys

1. On your project dashboard, click the **`</>`** (Web) icon to add a web app
2. Give it a nickname (e.g. `surveytrack-web`) — no need to check "Firebase Hosting"
3. Click **Register app**
4. Firebase will show you a code block that looks like this:

```js
const firebaseConfig = {
  apiKey: "AIzaSyXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  authDomain: "surveytrack-xxxxx.firebaseapp.com",
  projectId: "surveytrack-xxxxx",
  storageBucket: "surveytrack-xxxxx.appspot.com",
  messagingSenderId: "123456789012",
  appId: "1:123456789012:web:abcdefabcdef"
};
```

5. **Copy these values** and paste them into `firebase-config.js` in this project, replacing the placeholder text.

> **Can't find the config later?**  
> Go to your Firebase project → click the ⚙️ gear icon → **Project settings** → scroll down to **"Your apps"** → click **Config**.

---

## Step 3 — Enable Firestore

1. In the Firebase console left sidebar, go to **Build → Firestore Database**
2. Click **Create database**
3. Choose **"Start in test mode"** (allows reads/writes for 30 days — fine for getting started)
4. Choose a region close to you (e.g. `europe-west1` for Europe) → click **Enable**

> ⚠️ **Test mode expires after 30 days.** Before it expires, go to Firestore → **Rules** and update to:
> ```
> rules_version = '2';
> service cloud.firestore {
>   match /databases/{database}/documents {
>     match /{document=**} {
>       allow read, write: if true;
>     }
>   }
> }
> ```
> This keeps the app working. For a production app you'd add proper auth rules.

---

## Step 4 — Run the app

Since `app.js` uses ES Modules (`import`), you **cannot** just open `index.html` by double-clicking it — browsers block module imports from local files.

### Option A — VS Code Live Server (easiest for local testing)
1. Install the **Live Server** extension in VS Code
2. Right-click `index.html` → **"Open with Live Server"**

### Option B — Python (if you have Python installed)
```bash
cd surveytrack-firebase
python3 -m http.server 8080
# then open http://localhost:8080
```

### Option C — Publish to GitHub Pages (recommended)
1. Push all files to a GitHub repo
2. Go to **Settings → Pages → Deploy from branch → main / root**
3. Your app is live — Firebase works over HTTPS automatically

---

## File structure

```
surveytrack-firebase/
├── index.html          — app screens
├── style.css           — all styles
├── app.js              — all logic + Firebase calls
├── firebase-config.js  — ← PASTE YOUR KEYS HERE
└── SETUP.md            — this guide
```

---

## Firestore data structure

```
weeks/
  {weekId}/
    name: "Week 1 – Introduction"
    order: 1234567890         ← used for sorting
    createdAt: 1234567890
    surveys/
      {surveyId}/
        name: "Pre-course survey"
        url:  "https://forms.google.com/..."
        createdAt: 1234567890

students/
  {studentFullName}/
    pass: "theirpassword"
    createdAt: 1234567890

completions/
  {studentFullName}/
    done/
      {surveyId}/
        done: true
        at:   1234567890
```

---

## Changing the instructor password

Open `firebase-config.js` and change:

```js
export const INSTRUCTOR_CREDS = {
  user: "instructor",
  pass: "yourNewPassword",
};
```

---

## Free tier limits (Firebase Spark plan)

| Resource | Free limit |
|---|---|
| Firestore reads | 50,000 / day |
| Firestore writes | 20,000 / day |
| Storage | 1 GB |

More than enough for a class of students.
