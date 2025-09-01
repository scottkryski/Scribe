import * as api from "../api.js";
import * as ui from "../ui.js";

let state = {};
let lockTimerInterval = null;

export function stopLockTimer() {
  if (lockTimerInterval) {
    clearInterval(lockTimerInterval);
    lockTimerInterval = null;
  }
  const timerDisplay = document.getElementById("lock-timer-display");
  if (timerDisplay) {
    timerDisplay.classList.add("hidden");
  }
}

export async function startLockTimer() {
  stopLockTimer();
  if (!state.currentPaper) return;

  const timerDisplay = document.getElementById("lock-timer-display");
  const countdownElement = document.getElementById("lock-timer-countdown");
  const initialStatus = await api.getLockStatus(state.currentPaper.doi);

  if (!initialStatus.locked || initialStatus.remaining_seconds <= 0) return;

  let remainingSeconds = initialStatus.remaining_seconds;

  function displayTime() {
    if (remainingSeconds <= 0) {
      countdownElement.textContent = "00:00:00";
      timerDisplay.classList.add("hidden");
      ui.showToastNotification(
        "Your lock on this paper has expired.",
        "warning"
      );
      stopLockTimer();
      return;
    }
    const hours = Math.floor(remainingSeconds / 3600);
    const minutes = Math.floor((remainingSeconds % 3600) / 60);
    const seconds = remainingSeconds % 60;
    countdownElement.textContent = `${String(hours).padStart(2, "0")}:${String(
      minutes
    ).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    timerDisplay.classList.remove("hidden");
  }

  lockTimerInterval = setInterval(() => {
    remainingSeconds--;
    displayTime();
  }, 1000);

  displayTime();
}

export function initializeLockTimer(_state) {
  state = _state;
  // This module exports functions directly, no need to return an object
}
