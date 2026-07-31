(() => {
  "use strict";

  const config = window.SCHEDULE_APP_CONFIG || {};
  const API_BASE_URL = String(config.apiBaseUrl || "").replace(/\/$/, "");

  function getClientId() {
    return window.crypto?.randomUUID?.() ||
      `viewer-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  const CLIENT_ID = getClientId();
  const TIME_LABELS = [
    "8:00 PM",
    "8:30 PM",
    "9:00 PM",
    "9:30 PM",
    "10:00 PM",
    "10:30 PM",
    "11:00 PM",
    "11:30 PM",
    "12:00 AM",
    "12:30 AM",
    "1:00 AM",
    "1:30 AM"
  ];

  const list = document.getElementById("scheduleList");
  const modeButtons = Array.from(document.querySelectorAll(".mode-button"));
  const setTimesMode = document.getElementById("setTimesMode");
  const openDecksMode = document.getElementById("openDecksMode");
  const setTimesFrame = document.getElementById("setTimesFrame");
  const connectionPill = document.getElementById("connectionPill");
  const connectionText = document.getElementById("connectionText");
  const viewerCount = document.getElementById("viewerCount");
  const viewerPlural = document.getElementById("viewerPlural");
  const notesModal = document.getElementById("notesModal");
  const notesTime = document.getElementById("notesTime");
  const notesInput = document.getElementById("notesInput");
  const closeNotesButton = document.getElementById("closeNotesButton");
  const cancelNotesButton = document.getElementById("cancelNotesButton");
  const saveNotesButton = document.getElementById("saveNotesButton");
  const toast = document.getElementById("toast");

  let schedule = null;
  let socket = null;
  let scheduleSortable = null;
  let activeNoteSlotId = null;
  let isDragging = false;
  let pendingRemoteSchedule = null;
  let toastTimer = null;
  let lockHeartbeatTimer = null;
  let clientRegistrationPromise = Promise.resolve(false);
  const nameSaveTimers = new Map();
  const slotLocks = new Map();
  const ownedLockTokens = new Map();
  const localNameDrafts = new Map();
  let latestScheduleTimestamp = 0;

  function apiUrl(pathname) {
    return `${API_BASE_URL}${pathname}`;
  }

  function showToast(message, isError = false) {
    window.clearTimeout(toastTimer);
    toast.textContent = message;
    toast.className = `toast${isError ? " is-error" : ""}`;
    toast.hidden = false;
    toastTimer = window.setTimeout(() => {
      toast.hidden = true;
    }, 2600);
  }

  function setConnectionState(state) {
    connectionPill.className = `connection-pill is-${state}`;

    if (state === "online") {
      connectionText.textContent = "Live";
    } else if (state === "offline") {
      connectionText.textContent = "Offline";
    } else {
      connectionText.textContent = "Connecting";
    }
  }

  function showConfigurationError() {
    list.innerHTML = `
      <div class="error-state">
        Set the Railway URL in docs/config.js.
      </div>
    `;
    setConnectionState("offline");
  }

  async function request(pathname, options = {}) {
    const response = await fetch(apiUrl(pathname), {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(payload.error || "The schedule could not be updated.");
    }

    return payload;
  }

  function getNameInput(slotId) {
    return list.querySelector(
      `.name-input[data-slot-id="${CSS.escape(String(slotId))}"]`
    );
  }

  function getActiveNameInput() {
    const activeElement = document.activeElement;
    return activeElement?.classList.contains("name-input") ? activeElement : null;
  }

  function rememberLocalDraft(input, changes = {}) {
    const slotId = String(input.dataset.slotId || "");
    if (!slotId) return null;

    const current = localNameDrafts.get(slotId) || {};
    const draft = {
      value: input.value,
      selectionStart: input.selectionStart,
      selectionEnd: input.selectionEnd,
      composing: Boolean(current.composing),
      dirty: current.dirty !== false,
      ...current,
      ...changes,
      value: input.value,
      selectionStart: input.selectionStart,
      selectionEnd: input.selectionEnd
    };

    localNameDrafts.set(slotId, draft);
    return draft;
  }

  function shouldPreserveLocalInput(slotId, input = getNameInput(slotId)) {
    const normalizedSlotId = String(slotId);
    const draft = localNameDrafts.get(normalizedSlotId);

    return Boolean(
      input &&
      (
        document.activeElement === input ||
        hasOwnSlotLock(normalizedSlotId) ||
        draft?.dirty ||
        draft?.composing
      )
    );
  }

  function applyPendingRemoteSchedule() {
    if (
      !pendingRemoteSchedule ||
      isDragging ||
      getActiveNameInput() ||
      ownedLockTokens.size > 0
    ) {
      return;
    }

    const pending = pendingRemoteSchedule;
    pendingRemoteSchedule = null;
    renderSchedule(pending);
  }

  function hasOwnSlotLock(slotId) {
    return ownedLockTokens.has(String(slotId));
  }

  function isSlotLockedByOther(slotId) {
    const lock = slotLocks.get(String(slotId));
    return Boolean(lock && lock.clientId !== CLIENT_ID);
  }

  function applySlotLockStates() {
    list.querySelectorAll(".schedule-row").forEach((row) => {
      const slotId = row.dataset.slotId;
      const input = row.querySelector(".name-input");
      const status = row.querySelector(".slot-lock-status");
      const lock = slotLocks.get(slotId);
      if (!input || !status) return;
      const isOwn = Boolean(lock && lock.clientId === CLIENT_ID);
      const isOther = Boolean(lock && lock.clientId !== CLIENT_ID);

      row.classList.toggle("is-editing", isOwn);
      row.classList.toggle("is-locked", isOther);
      input.readOnly = isOther;
      input.classList.toggle("has-lock-status", Boolean(lock));
      input.setAttribute("aria-readonly", String(isOther));

      if (isOwn) {
        status.textContent = "Editing";
        status.hidden = false;
      } else if (isOther) {
        status.textContent = "In use";
        status.hidden = false;
      } else {
        status.textContent = "";
        status.hidden = true;
      }
    });
  }

  function updateSlotLocks(nextLocks = {}) {
    slotLocks.clear();

    Object.entries(nextLocks).forEach(([slotId, lock]) => {
      if (lock?.clientId) slotLocks.set(String(slotId), lock);
    });

    for (const slotId of ownedLockTokens.keys()) {
      const lock = slotLocks.get(slotId);
      if (!lock || lock.clientId !== CLIENT_ID) {
        ownedLockTokens.delete(slotId);
        window.clearTimeout(nameSaveTimers.get(slotId));
        nameSaveTimers.delete(slotId);

        const input = getNameInput(slotId);
        if (input && document.activeElement !== input) {
          localNameDrafts.delete(slotId);
        }
      }
    }

    applySlotLockStates();
  }

  async function requestSlotLock(slotId, input) {
    const normalizedSlotId = String(slotId);

    if (hasOwnSlotLock(normalizedSlotId)) {
      input.focus({ preventScroll: true });
      return true;
    }

    if (isSlotLockedByOther(normalizedSlotId)) {
      showToast("Another viewer is editing this slot.", true);
      return false;
    }

    if (!socket?.connected) {
      showToast("Reconnect before editing a slot.", true);
      return false;
    }

    const isRegistered = await clientRegistrationPromise.catch(() => false);
    if (!isRegistered) {
      showToast("The live editor is still connecting.", true);
      return false;
    }

    const row = input.closest(".schedule-row");
    row?.classList.add("is-lock-pending");
    input.readOnly = true;

    return new Promise((resolve) => {
      socket.timeout(3500).emit(
        "slot-lock:request",
        { slotId: normalizedSlotId, clientId: CLIENT_ID },
        (error, response = {}) => {
          row?.classList.remove("is-lock-pending");

          if (error || !response.granted || !response.token) {
            input.readOnly = isSlotLockedByOther(normalizedSlotId);
            showToast("Another viewer is editing this slot.", true);
            resolve(false);
            return;
          }

          ownedLockTokens.set(normalizedSlotId, response.token);
          slotLocks.set(normalizedSlotId, {
            clientId: CLIENT_ID,
            expiresAt: response.expiresAt
          });
          applySlotLockStates();
          input.readOnly = false;
          input.focus({ preventScroll: true });
          input.setSelectionRange(input.value.length, input.value.length);
          resolve(true);
        }
      );
    });
  }

  async function flushNameSave(slotId, name) {
    const normalizedSlotId = String(slotId);
    const lockToken = ownedLockTokens.get(normalizedSlotId);
    window.clearTimeout(nameSaveTimers.get(normalizedSlotId));
    nameSaveTimers.delete(normalizedSlotId);

    if (!lockToken) return;

    try {
      const updatedSchedule = await request(
        `/api/schedule/slots/${encodeURIComponent(normalizedSlotId)}`,
        {
          method: "PATCH",
          headers: {
            "X-Schedule-Client-Id": CLIENT_ID,
            "X-Schedule-Lock-Token": lockToken
          },
          body: JSON.stringify({ name })
        }
      );

      const draft = localNameDrafts.get(normalizedSlotId);
      if (draft) draft.dirty = false;
      renderSchedule(updatedSchedule);
    } catch (error) {
      showToast(error.message, true);
      await reloadSchedule();
    }
  }

  async function releaseSlotLock(slotId, name, saveBeforeRelease = true) {
    const normalizedSlotId = String(slotId);
    const token = ownedLockTokens.get(normalizedSlotId);
    if (!token) return;

    if (saveBeforeRelease) {
      await flushNameSave(normalizedSlotId, name);
    }

    socket?.emit("slot-lock:release", {
      slotId: normalizedSlotId,
      clientId: CLIENT_ID,
      token
    });
    ownedLockTokens.delete(normalizedSlotId);
    slotLocks.delete(normalizedSlotId);
    localNameDrafts.delete(normalizedSlotId);
    applySlotLockStates();
    applyPendingRemoteSchedule();
  }

  function startLockHeartbeat() {
    window.clearInterval(lockHeartbeatTimer);
    lockHeartbeatTimer = window.setInterval(() => {
      if (!socket?.connected) return;

      ownedLockTokens.forEach((token, slotId) => {
        socket.emit("slot-lock:heartbeat", {
          slotId,
          clientId: CLIENT_ID,
          token
        });
      });
    }, 10_000);
  }

  function noteButtonMarkup(hasNote) {
    if (hasNote) {
      return `
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6.5 4.5h11a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-6l-4.5 4v-4h-.5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Z"></path>
          <path d="M8 9h8M8 12h5"></path>
        </svg>
        <span class="sr-only">Edit note</span>
      `;
    }

    return `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 5v14M5 12h14"></path>
      </svg>
      <span class="note-label">Note</span>
    `;
  }

  function makeRow(slot, index) {
    const row = document.createElement("article");
    row.className = "schedule-row";
    row.dataset.slotId = slot.id;

    const handle = document.createElement("button");
    handle.type = "button";
    handle.className = "drag-handle";
    handle.setAttribute("aria-label", `Move ${TIME_LABELS[index]} slot`);
    handle.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="8" cy="6" r="1.5"></circle>
        <circle cx="16" cy="6" r="1.5"></circle>
        <circle cx="8" cy="12" r="1.5"></circle>
        <circle cx="16" cy="12" r="1.5"></circle>
        <circle cx="8" cy="18" r="1.5"></circle>
        <circle cx="16" cy="18" r="1.5"></circle>
      </svg>
    `;

    const time = document.createElement("time");
    time.className = "slot-time";
    time.textContent = TIME_LABELS[index];

    const input = document.createElement("input");
    input.className = "name-input";
    input.type = "text";
    input.maxLength = 150;
    input.placeholder = "Enter name";
    input.value = slot.name || "";
    input.dataset.slotId = slot.id;
    input.autocomplete = "off";
    input.autocapitalize = "words";
    input.enterKeyHint = "done";
    input.spellcheck = true;
    input.setAttribute("data-1p-ignore", "true");
    input.setAttribute("data-lpignore", "true");
    input.setAttribute("aria-label", `Name for ${TIME_LABELS[index]}`);

    const nameField = document.createElement("div");
    nameField.className = "name-field";

    const lockStatus = document.createElement("span");
    lockStatus.className = "slot-lock-status";
    lockStatus.id = `slot-lock-${slot.id}`;
    lockStatus.hidden = true;
    input.setAttribute("aria-describedby", lockStatus.id);

    input.addEventListener("pointerdown", (event) => {
      if (hasOwnSlotLock(slot.id)) return;
      event.preventDefault();
      requestSlotLock(slot.id, input);
    });

    input.addEventListener("focus", () => {
      if (hasOwnSlotLock(slot.id)) return;
      input.blur();
      requestSlotLock(slot.id, input);
    });

    input.addEventListener("beforeinput", (event) => {
      if (!hasOwnSlotLock(slot.id)) event.preventDefault();
    });

    input.addEventListener("compositionstart", () => {
      if (!hasOwnSlotLock(slot.id)) return;
      rememberLocalDraft(input, { composing: true, dirty: true });
    });

    input.addEventListener("input", () => {
      if (!hasOwnSlotLock(slot.id)) return;
      slot.name = input.value;
      const draft = rememberLocalDraft(input, { dirty: true });
      if (!draft?.composing) queueNameSave(slot.id, input.value);
    });

    input.addEventListener("compositionend", () => {
      if (!hasOwnSlotLock(slot.id)) return;
      slot.name = input.value;
      rememberLocalDraft(input, { composing: false, dirty: true });
      queueNameSave(slot.id, input.value);
    });

    input.addEventListener("select", () => {
      if (hasOwnSlotLock(slot.id)) rememberLocalDraft(input);
    });

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.isComposing) input.blur();
    });

    input.addEventListener("blur", () => {
      window.setTimeout(() => {
        if (document.activeElement !== input) {
          releaseSlotLock(slot.id, input.value, true);
        }
      }, 120);
    });

    input.addEventListener("click", () => {
      if (isSlotLockedByOther(slot.id)) {
        showToast("Another viewer is editing this slot.", true);
      }
    });

    nameField.append(input, lockStatus);

    const noteButton = document.createElement("button");
    noteButton.type = "button";
    noteButton.className = `note-button${slot.notes ? " has-note" : ""}`;
    noteButton.dataset.slotId = slot.id;
    noteButton.setAttribute(
      "aria-label",
      slot.notes ? `Edit note for ${TIME_LABELS[index]}` : `Add note for ${TIME_LABELS[index]}`
    );
    noteButton.innerHTML = noteButtonMarkup(Boolean(slot.notes));
    noteButton.addEventListener("click", () => openNotes(slot.id));

    row.append(handle, time, nameField, noteButton);
    return row;
  }

  function patchRow(row, slot, index) {
    row.dataset.slotId = slot.id;

    const time = row.querySelector(".slot-time");
    const input = row.querySelector(".name-input");
    const noteButton = row.querySelector(".note-button");
    const handle = row.querySelector(".drag-handle");
    const lockStatus = row.querySelector(".slot-lock-status");

    time.textContent = TIME_LABELS[index];
    input.dataset.slotId = slot.id;
    input.setAttribute("aria-label", `Name for ${TIME_LABELS[index]}`);
    handle.setAttribute("aria-label", `Move ${TIME_LABELS[index]} slot`);

    const hasNote = Boolean(slot.notes);
    const noteStateChanged = noteButton.classList.contains("has-note") !== hasNote;
    noteButton.dataset.slotId = slot.id;
    noteButton.classList.toggle("has-note", hasNote);
    noteButton.setAttribute(
      "aria-label",
      `${hasNote ? "Edit" : "Add"} note for ${TIME_LABELS[index]}`
    );
    if (noteStateChanged) noteButton.innerHTML = noteButtonMarkup(hasNote);

    lockStatus.id = `slot-lock-${slot.id}`;
    input.setAttribute("aria-describedby", lockStatus.id);

    if (!shouldPreserveLocalInput(slot.id, input) && input.value !== (slot.name || "")) {
      input.value = slot.name || "";
      input.scrollLeft = 0;
    }
  }

  function renderSchedule(nextSchedule) {
    if (!nextSchedule?.slots?.length) return;
  
    // Remove the initial loading message or a previous connection error
    // as soon as a valid schedule is received.
    list.querySelectorAll(".loading-state, .error-state").forEach((element) => {
      element.remove();
    });
  
    const incomingTimestamp = Date.parse(nextSchedule.updatedAt || "") || 0;
  
    if (incomingTimestamp && incomingTimestamp < latestScheduleTimestamp) {
      return;
    }
  
    latestScheduleTimestamp = Math.max(
      latestScheduleTimestamp,
      incomingTimestamp
    );
  
    if (isDragging) {
      pendingRemoteSchedule = nextSchedule;
      return;
    }
  
    const activeInput = getActiveNameInput();
    const activeSlotId = activeInput?.dataset.slotId || null;
  
    const existingRows = new Map(
      Array.from(list.querySelectorAll(".schedule-row")).map((row) => [
        row.dataset.slotId,
        row
      ])
    );
  
    const nextSlotIds = nextSchedule.slots.map((slot) => String(slot.id));
  
    const currentSlotIds = Array.from(
      list.querySelectorAll(".schedule-row")
    ).map((row) => row.dataset.slotId);
  
    const orderChanged =
      currentSlotIds.length === nextSlotIds.length &&
      currentSlotIds.some(
        (slotId, index) => slotId !== nextSlotIds[index]
      );
  
    const deferRemoteOrder = Boolean(orderChanged && activeSlotId);
  
    const mergedSlots = nextSchedule.slots.map((incomingSlot, index) => {
      const slotId = String(incomingSlot.id);
      let row = existingRows.get(slotId);
  
      if (!row) {
        row = makeRow(incomingSlot, index);
        existingRows.set(slotId, row);
        list.appendChild(row);
      }
  
      const input = row.querySelector(".name-input");
      const preserveLocal = shouldPreserveLocalInput(slotId, input);
      const currentIndex = currentSlotIds.indexOf(slotId);
  
      const displayIndex =
        deferRemoteOrder && currentIndex >= 0
          ? currentIndex
          : index;
  
      const mergedSlot = {
        ...incomingSlot,
        position: displayIndex,
        time: TIME_LABELS[displayIndex],
        name: preserveLocal
          ? input.value
          : incomingSlot.name || ""
      };
  
      patchRow(row, mergedSlot, displayIndex);
  
      return mergedSlot;
    });
  
    for (const [slotId, row] of existingRows.entries()) {
      if (!nextSlotIds.includes(slotId)) {
        row.remove();
      }
    }
  
    if (deferRemoteOrder) {
      pendingRemoteSchedule = nextSchedule;
    } else {
      mergedSlots.forEach((slot) => {
        const row = existingRows.get(String(slot.id));
  
        if (row && row.parentElement === list) {
          list.appendChild(row);
        }
      });
    }
  
    schedule = {
      ...nextSchedule,
      slots: mergedSlots
    };
  
    applySlotLockStates();
  }

  function refreshVisibleTimes() {
    list.querySelectorAll(".schedule-row").forEach((row, index) => {
      const time = row.querySelector(".slot-time");
      const input = row.querySelector(".name-input");
      const noteButton = row.querySelector(".note-button");
      const handle = row.querySelector(".drag-handle");

      time.textContent = TIME_LABELS[index];
      input.setAttribute("aria-label", `Name for ${TIME_LABELS[index]}`);
      noteButton.setAttribute(
        "aria-label",
        `${noteButton.classList.contains("has-note") ? "Edit" : "Add"} note for ${TIME_LABELS[index]}`
      );
      handle.setAttribute("aria-label", `Move ${TIME_LABELS[index]} slot`);
    });
  }

  function queueNameSave(slotId, name) {
    const normalizedSlotId = String(slotId);
    window.clearTimeout(nameSaveTimers.get(normalizedSlotId));

    const timer = window.setTimeout(async () => {
      await flushNameSave(normalizedSlotId, name);
    }, 350);

    nameSaveTimers.set(normalizedSlotId, timer);
  }

  function openNotes(slotId) {
    const slot = schedule?.slots.find((item) => item.id === slotId);
    if (!slot) return;

    activeNoteSlotId = slotId;
    notesTime.textContent = slot.time;
    notesInput.value = slot.notes || "";
    notesModal.hidden = false;
    document.body.style.overflow = "hidden";

    window.requestAnimationFrame(() => {
      notesInput.focus();
      notesInput.setSelectionRange(notesInput.value.length, notesInput.value.length);
    });
  }

  function closeNotes() {
    notesModal.hidden = true;
    activeNoteSlotId = null;
    document.body.style.overflow = "";
  }

  async function saveNotes() {
    if (!activeNoteSlotId) return;

    saveNotesButton.disabled = true;
    saveNotesButton.textContent = "Saving...";

    try {
      const updatedSchedule = await request(
        `/api/schedule/slots/${encodeURIComponent(activeNoteSlotId)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ notes: notesInput.value })
        }
      );

      renderSchedule(updatedSchedule);
      closeNotes();
      showToast("Note saved.");
    } catch (error) {
      showToast(error.message, true);
    } finally {
      saveNotesButton.disabled = false;
      saveNotesButton.textContent = "Save Note";
    }
  }

  async function persistCurrentOrder() {
    if (!schedule?.slots?.length) return;

    const slotIds = Array.from(list.querySelectorAll(".schedule-row")).map(
      (item) => item.dataset.slotId
    );

    if (slotIds.length !== schedule.slots.length) return;

    const slotMap = new Map(schedule.slots.map((slot) => [slot.id, slot]));
    schedule.slots = slotIds.map((id, index) => ({
      ...slotMap.get(id),
      position: index,
      time: TIME_LABELS[index]
    }));
    refreshVisibleTimes();

    try {
      const updatedSchedule = await request("/api/schedule/reorder", {
        method: "PUT",
        body: JSON.stringify({ slotIds })
      });
      pendingRemoteSchedule = null;
      renderSchedule(updatedSchedule);
    } catch (error) {
      pendingRemoteSchedule = null;
      showToast(error.message, true);
      await reloadSchedule();
    }
  }

  function initializeScheduleSorting() {
    if (scheduleSortable || typeof window.Sortable !== "function") return;

    scheduleSortable = window.Sortable.create(list, {
      animation: 170,
      handle: ".drag-handle",
      draggable: ".schedule-row",
      ghostClass: "is-drag-ghost",
      chosenClass: "is-drag-chosen",
      dragClass: "is-dragging",
      forceFallback: true,
      fallbackOnBody: true,
      fallbackTolerance: 4,
      touchStartThreshold: 3,
      delayOnTouchOnly: true,
      delay: 90,
      scroll: true,
      scrollSensitivity: 70,
      scrollSpeed: 12,
      onStart() {
        isDragging = true;
        pendingRemoteSchedule = null;
        document.body.classList.add("is-reordering");
      },
      onChange() {
        refreshVisibleTimes();
      },
      async onEnd() {
        isDragging = false;
        document.body.classList.remove("is-reordering");
        refreshVisibleTimes();
        await persistCurrentOrder();
      }
    });
  }

  function syncSetTimesFrameHeight() {
    if (!setTimesFrame?.contentDocument) return;

    const documentElement = setTimesFrame.contentDocument.documentElement;
    const body = setTimesFrame.contentDocument.body;
    const height = Math.max(
      documentElement?.scrollHeight || 0,
      documentElement?.offsetHeight || 0,
      body?.scrollHeight || 0,
      body?.offsetHeight || 0,
      640
    );

    setTimesFrame.style.height = `${height}px`;
  }

  function initializeSetTimesFrameSizing() {
    if (!setTimesFrame) return;

    setTimesFrame.addEventListener("load", () => {
      syncSetTimesFrameHeight();

      const frameBody = setTimesFrame.contentDocument?.body;
      if (frameBody && "ResizeObserver" in window) {
        const observer = new ResizeObserver(syncSetTimesFrameHeight);
        observer.observe(frameBody);
      }
    });

    window.addEventListener("resize", syncSetTimesFrameHeight, { passive: true });
  }

  function setMode(mode) {
    const showSetTimes = mode === "set-times";
    setTimesMode.hidden = !showSetTimes;
    openDecksMode.hidden = showSetTimes;

    modeButtons.forEach((button) => {
      const isActive = button.dataset.mode === mode;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-pressed", String(isActive));
    });

    if (showSetTimes) {
      window.requestAnimationFrame(syncSetTimesFrameHeight);
    }
  }


  async function reloadSchedule() {
    try {
      renderSchedule(await request("/api/schedule"));
    } catch (error) {
      list.innerHTML = `<div class="error-state">${error.message}</div>`;
      setConnectionState("offline");
    }
  }

  function connectRealtime() {
    const script = document.createElement("script");
    script.src = apiUrl("/socket.io/socket.io.js");

    script.addEventListener("load", () => {
      socket = window.io(API_BASE_URL, {
        transports: ["websocket", "polling"]
      });

      socket.on("connect", () => {
        setConnectionState("online");
        ownedLockTokens.clear();
        clientRegistrationPromise = new Promise((resolve) => {
          socket.timeout(3500).emit(
            "client:register",
            { clientId: CLIENT_ID },
            (error, response = {}) => resolve(!error && response.ok === true)
          );
        });
        startLockHeartbeat();
        applySlotLockStates();
      });
      socket.on("disconnect", () => {
        setConnectionState("offline");
        ownedLockTokens.clear();
        slotLocks.clear();
        localNameDrafts.clear();
        nameSaveTimers.forEach((timer) => window.clearTimeout(timer));
        nameSaveTimers.clear();
        clientRegistrationPromise = Promise.resolve(false);
        window.clearInterval(lockHeartbeatTimer);
        applySlotLockStates();
      });
      socket.on("connect_error", () => setConnectionState("offline"));
      socket.on("schedule:update", renderSchedule);
      socket.on("slot-locks:update", updateSlotLocks);
      socket.on("presence:update", ({ viewers }) => {
        const count = Math.max(Number(viewers) || 1, 1);
        viewerCount.textContent = String(count);
        viewerPlural.textContent = count === 1 ? "" : "s";
      });
    });

    script.addEventListener("error", () => {
      setConnectionState("offline");
      showToast("Real-time connection could not be loaded.", true);
    });

    document.head.appendChild(script);
  }

  modeButtons.forEach((button) => {
    button.addEventListener("click", () => setMode(button.dataset.mode));
  });

  window.addEventListener("beforeunload", () => {
    ownedLockTokens.forEach((token, slotId) => {
      socket?.emit("slot-lock:release", { slotId, clientId: CLIENT_ID, token });
    });
  });

  initializeSetTimesFrameSizing();
  setMode("set-times");
  initializeScheduleSorting();

  closeNotesButton.addEventListener("click", closeNotes);
  cancelNotesButton.addEventListener("click", closeNotes);
  saveNotesButton.addEventListener("click", saveNotes);

  notesModal.addEventListener("click", (event) => {
    if (event.target === notesModal) closeNotes();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !notesModal.hidden) closeNotes();

    if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !notesModal.hidden) {
      saveNotes();
    }
  });

  if (!API_BASE_URL || API_BASE_URL.includes("YOUR-RAILWAY-SERVICE")) {
    showConfigurationError();
    return;
  }

  reloadSchedule();
  connectRealtime();
})();
