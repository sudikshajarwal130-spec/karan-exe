
/* =========================================
   SOS GUARD - UPDATED MAIN JAVASCRIPT
   Firebase Compat SDK
========================================= */

const firebaseConfig = {
    apiKey: "AIzaSyB4C6UHLBfNkE6s-GlWDRi8t27iNS4m1yw",
    authDomain: "sos-guard.firebaseapp.com",
    databaseURL: "https://sos-guard-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "sos-guard",
    storageBucket: "sos-guard.firebasestorage.app",
    messagingSenderId: "262503933457",
    appId: "1:262503933457:web:c3c52cc1d533e614d473b0",
    measurementId: "G-46ZTN6N0JQ"
};

if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}

const auth = firebase.auth();
const database = firebase.database();

let currentUser = null;
let currentPosition = null;
let watchId = null;

let userMap = null;
let viewerMap = null;
let userMarker = null;
let viewerMarker = null;

let isSOSActive = false;
let isAlarmMuted = false;

let audioContext = null;
let alarmInterval = null;

let trackingId = localStorage.getItem("sosTrackingId");

const $ = (id) => document.getElementById(id);

function setText(id, value) {
    const element = $(id);
    if (element) element.textContent = value;
}

function show(id) {
    const element = $(id);
    if (element) element.classList.remove("hidden");
}

function hide(id) {
    const element = $(id);
    if (element) element.classList.add("hidden");
}

function logActivity(message) {
    const log = $("activityLog");
    if (!log) return;

    const item = document.createElement("div");
    item.className = "activity-item";
    item.textContent =
        `${new Date().toLocaleTimeString()} — ${message}`;

    log.prepend(item);
}

function setStatus(message) {
    setText("systemStatus", message);
}

/* =========================================
   CLOCK & INTERNET
========================================= */

function updateClock() {
    setText("headerClock", new Date().toLocaleTimeString());
}

setInterval(updateClock, 1000);
updateClock();

function updateInternetStatus() {
    const online = navigator.onLine;

    setText("internetState", online ? "ONLINE" : "OFFLINE");
    setText(
        "internetPermissionStatus",
        online ? "Internet available" : "Internet unavailable"
    );
}

window.addEventListener("online", updateInternetStatus);
window.addEventListener("offline", updateInternetStatus);

updateInternetStatus();

/* =========================================
   TRACKING ID
========================================= */

function createTrackingId() {
    if (trackingId) return trackingId;

    const bytes = new Uint8Array(20);
    crypto.getRandomValues(bytes);

    trackingId = Array.from(bytes)
        .map(byte => byte.toString(16).padStart(2, "0"))
        .join("");

    localStorage.setItem("sosTrackingId", trackingId);

    return trackingId;
}

/* =========================================
   GOOGLE SIGN-IN
========================================= */

async function googleSignIn() {
    try {
        setText("loginMessage", "Opening Google Sign-In...");

        const provider = new firebase.auth.GoogleAuthProvider();

        await auth.signInWithPopup(provider);

        setText("loginMessage", "Login successful.");
        logActivity("Google account signed in.");

    } catch (error) {
        console.error("Google sign-in error:", error);
        setText("loginMessage", error.message);
    }
}

async function googleSignOut() {
    try {
        stopLocationTracking();
        stopAlarmCompletely();

        await auth.signOut();

        currentPosition = null;
        isSOSActive = false;

        setText("locationState", "Not signed in");
        setText("cloudState", "Disconnected");

        logActivity("User signed out.");

    } catch (error) {
        console.error(error);
        setStatus("Sign-out failed.");
    }
}

auth.onAuthStateChanged(async (user) => {
    currentUser = user;

    if (!user) {
        stopLocationTracking();

        hide("accountSection");
        hide("userView");
        hide("viewerView");
        show("loginSection");

        setText("authStatus", "Not signed in");
        setText("cloudState", "Disconnected");
        setText("locationState", "Not signed in");
        setText("cloudPermissionStatus", "Sign in required");

        setStatus("Please sign in with Google.");

        return;
    }

    hide("loginSection");
    show("accountSection");

    setText(
        "loggedInUser",
        user.displayName || user.email || "User"
    );

    setText("loggedInUID", user.uid);
    setText("authStatus", "Authenticated");
    setText("cloudState", "Connected");
    setText("cloudPermissionStatus", "Signed in");

    try {
        await database.ref("users/" + user.uid + "/profile").update({
            name: user.displayName || "",
            email: user.email || "",
            updatedAt: Date.now()
        });

        setText("cloudState", "Connected");

    } catch (error) {
        console.error("Profile save failed:", error);
        setText("cloudState", "Sync failed");
    }

    setStatus("Account connected.");
    logActivity("Account authenticated.");

    const params = new URLSearchParams(location.search);

    if (params.get("view") === "track") {
        hide("userView");
        show("viewerView");

        setText(
            "viewerMessage",
            "Live viewer access is not configured yet."
        );

        setText("viewerState", "Access unavailable");

        return;
    }

    hide("viewerView");
    show("userView");

    initializeUserMap();

    // Start GPS after successful sign-in.
    requestLocation();
    checkPermissions();
});

/* =========================================
   USER MAP
========================================= */

function initializeUserMap() {
    if (userMap || !$("userMap")) return;

    userMap = L.map("userMap").setView([26.9124, 75.7873], 13);

    L.tileLayer(
        "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
        {
            attribution: "&copy; OpenStreetMap contributors"
        }
    ).addTo(userMap);

    setTimeout(() => userMap.invalidateSize(), 300);
}

function updateUserMap(position) {
    if (!userMap) initializeUserMap();

    if (!userMap) return;

    const lat = position.coords.latitude;
    const lon = position.coords.longitude;

    const personIcon = L.divIcon({
        className: "person-marker",
        html: '<div class="person-marker-inner">🚶</div>',
        iconSize: [40, 40],
        iconAnchor: [20, 20]
    });

    if (!userMarker) {
        userMarker = L.marker(
            [lat, lon],
            { icon: personIcon }
        ).addTo(userMap);
    } else {
        userMarker.setLatLng([lat, lon]);
    }

    userMap.setView([lat, lon], 16);
}

/* =========================================
   GPS LOCATION
========================================= */

function handleLocationError(error) {
    console.error("GPS error:", error);

    let message = "Location unavailable";
    let permissionMessage = "Location error";

    switch (error.code) {
        case 1:
            message = "Location permission denied";
            permissionMessage = "Permission denied";
            break;

        case 2:
            message = "GPS position unavailable";
            permissionMessage = "Position unavailable";
            break;

        case 3:
            message = "GPS request timed out";
            permissionMessage = "Request timed out";
            break;
    }

    setText("locationState", message);
    setText("locationPermissionStatus", permissionMessage);
    setText("trackingStatus", "GPS not updating");

    setStatus(message);
}

function requestLocation() {
    if (!currentUser) {
        setText("locationState", "Sign in required");
        return;
    }

    if (!navigator.geolocation) {
        setText("locationState", "GPS not supported");
        setText("locationPermissionStatus", "Not supported");
        return;
    }

    if (!window.isSecureContext) {
        setText("locationState", "Secure connection required");
        setText("locationPermissionStatus", "HTTPS required");
        setStatus("Open the website using HTTPS or localhost.");
        return;
    }

    setText("locationState", "Requesting GPS...");
    setText("locationPermissionStatus", "Requesting permission...");

    navigator.geolocation.getCurrentPosition(
        (position) => {
            currentPosition = position;

            updateLocationUI(position);
            startLocationTracking();
            publishLocation();
        },
        handleLocationError,
        {
            enableHighAccuracy: true,
            timeout: 30000,
            maximumAge: 0
        }
    );
}

function startLocationTracking() {
    if (!navigator.geolocation || watchId !== null) return;

    watchId = navigator.geolocation.watchPosition(
        (position) => {
            currentPosition = position;

            updateLocationUI(position);
            publishLocation();
        },
        (error) => {
            console.error("GPS tracking error:", error);

            setText("trackingStatus", "GPS update unavailable");

            if (error.code === 1) {
                setText(
                    "locationPermissionStatus",
                    "Permission denied"
                );
            }
        },
        {
            enableHighAccuracy: true,
            maximumAge: 5000,
            timeout: 30000
        }
    );
}

function stopLocationTracking() {
    if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
    }

    setText("trackingStatus", "Tracking stopped");
}

function updateLocationUI(position) {
    const lat = position.coords.latitude;
    const lon = position.coords.longitude;
    const accuracy = Math.round(position.coords.accuracy);

    setText("latitude", lat.toFixed(6));
    setText("longitude", lon.toFixed(6));
    setText("accuracy", accuracy + " metres");

    setText(
        "lastUpdated",
        new Date(position.timestamp).toLocaleString()
    );

    setText("locationState", "Location available");
    setText("locationPermissionStatus", "Permission granted");
    setText("trackingStatus", "Live GPS tracking active");
    setText("trackingDot", "●");

    const mapLink = $("openMapLink");

    if (mapLink) {
        mapLink.href =
            `https://www.google.com/maps?q=${lat},${lon}`;
    }

    updateUserMap(position);
}

/* =========================================
   FIREBASE LOCATION SYNC
========================================= */

async function publishLocation() {
    if (!currentUser || !currentPosition) return;

    if (!navigator.onLine) {
        setText("cloudState", "Offline");
        return;
    }

    const position = currentPosition;

    try {
        await database
            .ref("users/" + currentUser.uid + "/location")
            .update({
                active: isSOSActive,
                updatedAt: Date.now(),
                latitude: position.coords.latitude,
                longitude: position.coords.longitude,
                accuracy: position.coords.accuracy
            });

        setText("cloudState", "Synced");

    } catch (error) {
        console.error("Cloud update failed:", error);
        setText("cloudState", "Sync failed");
    }
}

/* =========================================
   SOS SOUND
========================================= */

async function startAlarm() {
    try {
        const AudioContextClass =
            window.AudioContext || window.webkitAudioContext;

        if (!AudioContextClass) {
            setText("alertStatus", "SOS active — sound unavailable");
            return;
        }

        if (!audioContext || audioContext.state === "closed") {
            audioContext = new AudioContextClass();
        }

        if (audioContext.state === "suspended") {
            await audioContext.resume();
        }

        if (!isSOSActive || isAlarmMuted) return;

        function beep() {
            if (
                !audioContext ||
                audioContext.state !== "running" ||
                !isSOSActive ||
                isAlarmMuted
            ) {
                return;
            }

            const oscillator = audioContext.createOscillator();
            const gain = audioContext.createGain();

            oscillator.type = "sawtooth";
            oscillator.frequency.value = 850;

            gain.gain.setValueAtTime(
                0.12,
                audioContext.currentTime
            );

            oscillator.connect(gain);
            gain.connect(audioContext.destination);

            oscillator.start();

            oscillator.stop(
                audioContext.currentTime + 0.35
            );
        }

        if (alarmInterval) {
            clearInterval(alarmInterval);
        }

        beep();
        alarmInterval = setInterval(beep, 650);

        setText("alertStatus", "SOS ALERT ACTIVE");

    } catch (error) {
        console.error("Audio error:", error);

        setText(
            "alertStatus",
            "SOS active — sound unavailable"
        );
    }
}

function silenceAlarm() {
    isAlarmMuted = true;

    if (alarmInterval) {
        clearInterval(alarmInterval);
        alarmInterval = null;
    }

    if (audioContext && audioContext.state !== "closed") {
        audioContext.close();
        audioContext = null;
    }

    setText(
        "alertStatus",
        isSOSActive ? "SOS ACTIVE — SOUND MUTED" : "No active alert"
    );
}

function stopAlarmCompletely() {
    if (alarmInterval) {
        clearInterval(alarmInterval);
        alarmInterval = null;
    }

    if (audioContext && audioContext.state !== "closed") {
        audioContext.close();
    }

    audioContext = null;
    isAlarmMuted = false;
}

/* =========================================
   SOS CONTROLS
========================================= */

async function activateSOS() {
    if (!currentUser) {
        setStatus("Sign in before activating the demo alert.");
        return;
    }

    isSOSActive = true;
    isAlarmMuted = false;

    setText("alertState", "ACTIVE");
    setText("alertStatus", "SOS ALERT ACTIVE");

    setStatus("Emergency demo alert activated.");

    logActivity("SOS demo alert activated.");

    startAlarm();

    // Update Firebase if GPS data already exists.
    await publishLocation();

    // Ask for GPS if no location has been received yet.
    if (!currentPosition) {
        requestLocation();
    }
}

async function stopSOS() {
    isSOSActive = false;

    stopAlarmCompletely();

    setText("alertState", "INACTIVE");
    setText("alertStatus", "SOS alert stopped");

    setStatus("SOS demo alert stopped.");

    await publishLocation();

    logActivity("SOS alert stopped.");
}

/* =========================================
   EMERGENCY CONTACTS
========================================= */

function loadContacts() {
    let saved = {};

    try {
        saved = JSON.parse(
            localStorage.getItem("sosContacts") || "{}"
        );
    } catch (error) {
        console.error("Contacts loading error:", error);
    }

    if ($("contact1Name")) {
        $("contact1Name").value = saved.name1 || "";
    }

    if ($("contact1Phone")) {
        $("contact1Phone").value = saved.phone1 || "";
    }

    if ($("contact2Name")) {
        $("contact2Name").value = saved.name2 || "";
    }

    if ($("contact2Phone")) {
        $("contact2Phone").value = saved.phone2 || "";
    }

    updateWhatsAppLinks();
}

function saveContacts() {
    const name1 = $("contact1Name")?.value.trim() || "";
    const phone1 = $("contact1Phone")?.value.trim() || "";

    const name2 = $("contact2Name")?.value.trim() || "";
    const phone2 = $("contact2Phone")?.value.trim() || "";

    localStorage.setItem(
        "sosContacts",
        JSON.stringify({
            name1,
            phone1,
            name2,
            phone2
        })
    );

    updateWhatsAppLinks();

    setText("contactMessage", "Contacts saved on this device.");

    logActivity("Emergency contacts saved locally.");
}

function makeWhatsAppLink(phone) {
    if (!phone) return "#";

    let number = phone.replace(/\D/g, "");

    if (number.length === 10) {
        number = "91" + number;
    }

    let message =
        "SOS! I need help. Please contact me.";

    if (currentPosition) {
        const lat = currentPosition.coords.latitude;
        const lon = currentPosition.coords.longitude;

        message +=
            ` My location: https://www.google.com/maps?q=${lat},${lon}`;
    }

    // Localhost tracking URLs are not usable by other devices.
    if (
        location.hostname !== "127.0.0.1" &&
        location.hostname !== "localhost"
    ) {
        const link =
            `${location.origin}${location.pathname}`;

        message += ` Website: ${link}`;
    }

    return (
        `https://wa.me/${number}?text=` +
        encodeURIComponent(message)
    );
}

function updateWhatsAppLinks() {
    let saved = {};

    try {
        saved = JSON.parse(
            localStorage.getItem("sosContacts") || "{}"
        );
    } catch (error) {
        console.error(error);
    }

    const link1 = $("whatsapp1");
    const link2 = $("whatsapp2");

    if (link1) {
        link1.href = makeWhatsAppLink(saved.phone1 || "");
        link1.target = "_blank";
        link1.rel = "noopener";
    }

    if (link2) {
        link2.href = makeWhatsAppLink(saved.phone2 || "");
        link2.target = "_blank";
        link2.rel = "noopener";
    }
}

/* =========================================
   TRACKING VIEWER
========================================= */

function startViewer() {
    setText(
        "viewerState",
        "Viewer access not configured"
    );

    setText(
        "viewerMessage",
        "Secure tracking access has not been configured."
    );
}

/* =========================================
   PERMISSION CHECK
========================================= */

async function checkPermissions() {
    setText(
        "internetPermissionStatus",
        navigator.onLine
            ? "Internet available"
            : "Internet unavailable"
    );

    if (!navigator.geolocation) {
        setText(
            "locationPermissionStatus",
            "GPS not supported"
        );
    } else if (!window.isSecureContext) {
        setText(
            "locationPermissionStatus",
            "HTTPS or localhost required"
        );
    } else if (navigator.permissions?.query) {
        try {
            const result = await navigator.permissions.query({
                name: "geolocation"
            });

            if (result.state === "granted") {
                setText(
                    "locationPermissionStatus",
                    "Permission granted"
                );
            } else if (result.state === "denied") {
                setText(
                    "locationPermissionStatus",
                    "Permission denied"
                );
            } else {
                setText(
                    "locationPermissionStatus",
                    "Permission not requested"
                );
            }

            result.onchange = () => {
                checkPermissions();
            };

        } catch (error) {
            console.error("Permission check error:", error);

            setText(
                "locationPermissionStatus",
                "Permission status unavailable"
            );
        }
    } else {
        setText(
            "locationPermissionStatus",
            "Permission status unavailable"
        );
    }

    setText(
        "cloudPermissionStatus",
        currentUser ? "Signed in" : "Sign in required"
    );
}

/* =========================================
   SHARE LINK
========================================= */

function createShareLink() {
    createTrackingId();

    setText(
        "shareLink",
        "Secure tracking access not configured"
    );

    setText(
        "shareHelp",
        "Live tracking links are disabled until secure viewer access is configured."
    );

    setText(
        "shareLinkStatus",
        "Tracking link unavailable."
    );
}

async function copyShareLink() {
    setText(
        "shareLinkStatus",
        "Secure tracking link is not available yet."
    );
}

/* =========================================
   BUTTON EVENTS
========================================= */

$("googleSignInButton")?.addEventListener(
    "click",
    googleSignIn
);

$("googleSignOutButton")?.addEventListener(
    "click",
    googleSignOut
);

$("sosButton")?.addEventListener(
    "click",
    activateSOS
);

$("silenceButton")?.addEventListener(
    "click",
    silenceAlarm
);

$("stopButton")?.addEventListener(
    "click",
    stopSOS
);

$("saveContacts")?.addEventListener(
    "click",
    saveContacts
);

$("permissionButton")?.addEventListener(
    "click",
    async () => {
        await checkPermissions();

        // Explicit button click requests GPS permission.
        if (currentUser) {
            requestLocation();
        } else {
            setStatus("Sign in before checking GPS.");
        }
    }
);

$("copyLinkButton")?.addEventListener(
    "click",
    copyShareLink
);

$("clearLog")?.addEventListener("click", () => {
    const log = $("activityLog");

    if (log) log.innerHTML = "";
});

/* =========================================
   STARTUP
========================================= */

document.addEventListener("DOMContentLoaded", () => {
    loadContacts();
    createShareLink();
    updateClock();
    updateInternetStatus();

    // Do not request GPS before sign-in.
    checkPermissions();

    logActivity("SOS Guard interface loaded.");
});
