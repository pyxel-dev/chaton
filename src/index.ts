import dotenv from 'dotenv';
import firebase from "firebase/app";
import "firebase/firestore";
import "firebase/analytics";

dotenv.config({ path: "../.env" });

firebase.initializeApp({
  apiKey: process.env.FB_API_KEY,
  authDomain: process.env.FB_AUTH_DOMAIN,
  databaseURL: process.env.FB_DATABASE_URL,
  projectId: process.env.FB_PROJECT_ID,
  storageBucket: process.env.FB_STORAGE_BUCKET,
  messagingSenderId: process.env.FB_MESSAGING_SENDER_ID,
  appId: process.env.FB_APP_ID,
  measurementId: process.env.FB_MEASUREMENT_ID,
});

enum STEP {
  INIT,
  CREATE,
  JOIN
}

const STUN_SERVER = {
  urls: "stun:stun1.l.google.com:19302",
  username: "",
  credentials: ""
};

const configuration = {
  iceServers: [STUN_SERVER]
};

let peerConnection: RTCPeerConnection;
let localStream: MediaStream;
let remoteStream: MediaStream;
let roomId: string;
let ready = false;
const analytics = firebase.analytics();

/**
 * Call immediately for init the app
*/
function init() {
  checkProductHunt();
  // Init button action
  document.querySelector("#create").addEventListener("click", createRoom);
  document.querySelector("#join").addEventListener("click", joinRoom);
  document.querySelector("#quit").addEventListener("click", quit);

  // Init buttons visibility
  toggleButtonsHeader(STEP.INIT);
}

init();

/**
 * Check if ref=producthunt exist for show badge
 */
function checkProductHunt() {
  const producthuntEl: HTMLAnchorElement = document.querySelector('#producthunt');
  const url = window.location.search;
  const urlParams = new URLSearchParams(url);
  const refValue = urlParams.get('ref');
  producthuntEl.style.display = refValue === 'producthunt' ? "block" : "none";
}

/**
 * Create the room
 */
async function createRoom() {
  analytics.logEvent('click', { type: 'create_room' });

  if (!ready) {
    await setMedia();
  }

  // Connect to firebase
  const db: firebase.firestore.Firestore = firebase.firestore();

  // Get DocumentReference
  const roomRef: firebase.firestore.DocumentReference = await db.collection("rooms").doc();

  // Create a RTC Peer Connection with configuration
  peerConnection = new RTCPeerConnection(configuration);

  registerPeerConnectionListeners();

  localStream.getTracks().forEach((track: MediaStreamTrack) => {
    peerConnection.addTrack(track, localStream);
  });

  // Code for collecting ICE candidates
  const callerCandidatesCollection = roomRef.collection("callerCandidates");
  peerConnection.addEventListener("icecandidate", (event) => {
    if (!event.candidate) {
      return;
    }
    callerCandidatesCollection.add(event.candidate.toJSON());
  });

  // Code for creating a room
  const offer: RTCSessionDescriptionInit = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  const roomWithOffer = {
    offer: {
      type: offer.type,
      sdp: offer.sdp,
    },
  };
  await roomRef.set(roomWithOffer);
  roomId = roomRef.id;
  const roomIdEl: HTMLSpanElement = document.querySelector("#roomID");
  roomIdEl.innerText = roomRef.id;
  roomIdEl.addEventListener('click', (e) => {
    e.preventDefault();
    copyText(roomRef.id);
  });

  // Listening the track remote
  peerConnection.addEventListener("track", (event) => {
    event.streams[0].getTracks().forEach((track) => {
      remoteStream.addTrack(track);
    });
  });

  // Listening for remote session description
  // TODO : typeing data()
  // eslint-disable-next-line
  roomRef.onSnapshot(async (snapshot: { data: () => any }) => {
    const data = snapshot.data();
    if (!peerConnection.currentRemoteDescription && data && data.answer) {
      const rtcSessionDescription = new RTCSessionDescription(data.answer);
      await peerConnection.setRemoteDescription(rtcSessionDescription);
    }
  });

  // Listen for remote ICE candidates
  roomRef
    .collection("calleeCandidates")
    .onSnapshot((snapshot: { docChanges: () => firebase.firestore.DocumentChange<RTCIceCandidateInit>[] }) => {
      snapshot
        .docChanges()
        .forEach(async (change: { type: string; doc: { data: () => RTCIceCandidateInit } }) => {
          if (change.type === "added") {
            const data: RTCIceCandidateInit = change.doc.data();
            await peerConnection.addIceCandidate(new RTCIceCandidate(data));
          }
        });
    });

  // Display Room ID
  toggleButtonsHeader(STEP.CREATE);
}

/**
 * Join the room
 */
async function joinRoom() {
  analytics.logEvent('click', { type: 'join_room' });

  if (!ready) {
    await setMedia();
  }
  toggleButtonsHeader(STEP.JOIN);

  // Join the room with ID
  document.querySelector("#joinSession").addEventListener(
    "click",
    async (e) => {
      e.preventDefault();

      (document.querySelector("#joinedRoomID") as HTMLFormElement).style.display = "none";
      roomId = (document.querySelector("#joinRoomID") as HTMLInputElement).value;
      await joinRoomById(roomId);
    },
    { once: true }
  );
}

/**
 * Join the room with ID
 */
async function joinRoomById(roomId: string) {
  const db = firebase.firestore();
  const roomRef = db.collection("rooms").doc(`${roomId}`);
  const roomSnapshot = await roomRef.get();

  if (roomSnapshot.exists) {
    peerConnection = new RTCPeerConnection(configuration);
    registerPeerConnectionListeners();
    localStream.getTracks().forEach((track: MediaStreamTrack) => {
      peerConnection.addTrack(track, localStream);
    });

    // Code for collecting ICE candidates
    const calleeCandidatesCollection = roomRef.collection("calleeCandidates");
    peerConnection.addEventListener("icecandidate", (event) => {
      if (!event.candidate) {
        return;
      }
      calleeCandidatesCollection.add(event.candidate.toJSON());
    });

    peerConnection.addEventListener("track", (event) => {
      event.streams[0].getTracks().forEach((track: MediaStreamTrack) => {
        remoteStream.addTrack(track);
      });
    });

    // Code for creating SDP answer
    const offer = roomSnapshot.data().offer;
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    const roomWithAnswer = {
      answer: {
        type: answer.type,
        sdp: answer.sdp,
      },
    };
    await roomRef.update(roomWithAnswer);

    // Listening for remote ICE candidates
    roomRef
      .collection("callerCandidates")
      .onSnapshot((snapshot: { docChanges: () => firebase.firestore.DocumentChange<RTCIceCandidateInit>[] }) => {
        snapshot
          .docChanges()
          .forEach(
            async (change: { type: string; doc: { data: () => RTCIceCandidateInit } }) => {
              if (change.type === "added") {
                const data: RTCIceCandidateInit = change.doc.data();
                await peerConnection.addIceCandidate(new RTCIceCandidate(data));
              }
            }
          );
      });
  }
}

/**
 * Setup the camera and micro
 */
async function setMedia() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: true,
    audio: true,
  });
  (document.querySelector("#localVideo") as HTMLVideoElement).srcObject = stream;
  localStream = stream;
  remoteStream = new MediaStream();
  (document.querySelector("#remoteVideo") as HTMLVideoElement).srcObject = remoteStream;

  ready = true;
}

/**
 * Quit the room
 */
async function quit() {
  analytics.logEvent('click', { type: 'quit_room' });
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  const tracks: MediaStreamTrack[] = (document.querySelector("#localVideo") as HTMLVideoElement).srcObject.getTracks();
  tracks.forEach((track: { stop: () => void }) => {
    track.stop();
  });

  if (remoteStream) {
    remoteStream
      .getTracks()
      .forEach((track: { stop: () => void }) => track.stop());
  }

  if (peerConnection) {
    peerConnection.close();
  }

  // Reset DOM
  (document.querySelector("#localVideo") as HTMLVideoElement).srcObject = null;
  (document.querySelector("#remoteVideo") as HTMLVideoElement).srcObject = null;
  toggleButtonsHeader(STEP.INIT);
  ready = false;

  // Delete room
  if (roomId) {
    const db = firebase.firestore();
    const roomRef = db.collection("rooms").doc(roomId);
    const calleeCandidates = await roomRef.collection("calleeCandidates").get();
    calleeCandidates.forEach(
      async (candidate: { ref: { delete: () => void } }) => {
        await candidate.ref.delete();
      }
    );
    const callerCandidates = await roomRef.collection("callerCandidates").get();
    callerCandidates.forEach(
      async (candidate: { ref: { delete: () => void } }) => {
        await candidate.ref.delete();
      }
    );
    await roomRef.delete();
  }

  document.location.reload(true);
}

/**
 * Copy room ID when click on
 * @param roomID
 */
function copyText(roomID: string) {
  analytics.logEvent('click', { type: 'copy_room' });
  const container: HTMLElement = document.body;
  const input: HTMLInputElement = document.createElement("input");
  container.appendChild(input);
  input.type = "text";
  input.className = "input-none";
  input.value = roomID;
  input.select();
  document.execCommand("copy");
  displayTooltip("Room ID copied");
  setTimeout(() => {
    container.removeChild(input);
  }, 0);
}

function displayTooltip(type: string) {
  const tooltipEl: HTMLElement = document.querySelector('#tooltip');
  tooltipEl.innerHTML = `<p>${type}</p>`;
  tooltipEl.style.display = 'block';

  setTimeout(() => {
    tooltipEl.style.display = 'none';
  }, 2000);
}

/**
 * Display certain information depending on the context
 */
function toggleButtonsHeader(step: STEP) {
  const create: HTMLButtonElement = document.querySelector("#create");
  const join: HTMLButtonElement = document.querySelector("#join");
  const quit: HTMLButtonElement = document.querySelector("#quit");
  const infos: HTMLButtonElement = document.querySelector("#infos");
  const createdRoomID: HTMLElement = document.querySelector("#createdRoomID");
  const joinedRoomID: HTMLFormElement = (document.querySelector("#joinedRoomID") as HTMLFormElement);

  if (step === STEP.INIT) {
    create.disabled = false;
    join.disabled = false;
    quit.disabled = true;
    infos.disabled = false;
    createdRoomID.style.display = "none";
    joinedRoomID.style.display = "none";
  }
  if (step === STEP.CREATE) {
    create.disabled = true;
    join.disabled = true;
    quit.disabled = false;
    infos.disabled = true;
    createdRoomID.style.display = "block";
    joinedRoomID.style.display = "none";
  }
  if (step === STEP.JOIN) {
    create.disabled = true;
    join.disabled = true;
    quit.disabled = false;
    infos.disabled = true;
    createdRoomID.style.display = "none";
    joinedRoomID.style.display = "block";
  }
}

/**
 * Listening Peer Connection
 */
function registerPeerConnectionListeners() {
  peerConnection.addEventListener("icegatheringstatechange", () => {
    console.log(`ICE gathering state changed: ${peerConnection.iceGatheringState}`);
  });

  peerConnection.addEventListener("connectionstatechange", () => {
    console.log(`Connection state change: ${peerConnection.connectionState}`);
  });

  peerConnection.addEventListener("signalingstatechange", () => {
    console.log(`Signaling state change: ${peerConnection.signalingState}`);
  });

  peerConnection.addEventListener("iceconnectionstatechange ", () => {
    console.log(`ICE connection state change: ${peerConnection.iceConnectionState}`);
  });
}
