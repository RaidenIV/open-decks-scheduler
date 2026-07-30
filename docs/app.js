(() => {
  "use strict";

  const config = window.SCHEDULE_APP_CONFIG || {};
  const API_BASE_URL = String(config.apiBaseUrl || "").replace(/\/$/, "");
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
  let activeNoteSlotId = null;
  let isDragging = false;
  let pendingRemoteSchedule = null;
  let toastTimer = null;
  const nameSaveTimers = new Map();

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

  function getFocusedInputState() {
    const activeElement = document.activeElement;
    if (!activeElement?.classList.contains("name-input")) return null;

    return {
      slotId: activeElement.dataset.slotId,
      value: activeElement.value,
      start: activeElement.selectionStart,
      end: activeElement.selectionEnd
    };
  }

  function restoreFocusedInputState(focusState) {
    if (!focusState) return;

    const input = list.querySelector(
      `.name-input[data-slot-id="${CSS.escape(focusState.slotId)}"]`
    );

    if (!input) return;

    input.value = focusState.value;

    const focusedSlot = schedule?.slots.find(
      (slot) => slot.id === focusState.slotId
    );
    if (focusedSlot) focusedSlot.name = focusState.value;

    input.focus({ preventScroll: true });
    input.setSelectionRange(focusState.start, focusState.end);
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
    attachDragEvents(handle, row);

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
    input.setAttribute("aria-label", `Name for ${TIME_LABELS[index]}`);
    input.addEventListener("input", () => {
      slot.name = input.value;
      queueNameSave(slot.id, input.value);
    });

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

    row.append(handle, time, input, noteButton);
    return row;
  }

  function renderSchedule(nextSchedule) {
    if (!nextSchedule?.slots?.length) return;

    if (isDragging) {
      pendingRemoteSchedule = nextSchedule;
      return;
    }

    const focusState = getFocusedInputState();
    schedule = nextSchedule;
    const fragment = document.createDocumentFragment();

    schedule.slots.forEach((slot, index) => {
      fragment.appendChild(makeRow(slot, index));
    });

    list.replaceChildren(fragment);
    restoreFocusedInputState(focusState);
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
    window.clearTimeout(nameSaveTimers.get(slotId));

    const timer = window.setTimeout(async () => {
      try {
        await request(`/api/schedule/slots/${encodeURIComponent(slotId)}`, {
          method: "PATCH",
          body: JSON.stringify({ name })
        });
      } catch (error) {
        showToast(error.message, true);
        await reloadSchedule();
      } finally {
        nameSaveTimers.delete(slotId);
      }
    }, 350);

    nameSaveTimers.set(slotId, timer);
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

  function attachDragEvents(handle, row) {
    let pointerId = null;
    let dragged = false;

    handle.addEventListener("pointerdown", (event) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;

      pointerId = event.pointerId;
      dragged = true;
      isDragging = true;
      pendingRemoteSchedule = null;
      row.classList.add("is-dragging");
      document.body.classList.add("is-reordering");
      handle.setPointerCapture(pointerId);
      event.preventDefault();
    });

    handle.addEventListener("pointermove", (event) => {
      if (!dragged || event.pointerId !== pointerId) return;

      const target = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest(".schedule-row");

      if (target && target !== row && target.parentElement === list) {
        const rectangle = target.getBoundingClientRect();
        const insertAfter = event.clientY > rectangle.top + rectangle.height / 2;

        list.insertBefore(row, insertAfter ? target.nextSibling : target);
        refreshVisibleTimes();
      }

      const edge = 70;
      if (event.clientY < edge) {
        window.scrollBy({ top: -12, behavior: "auto" });
      } else if (event.clientY > window.innerHeight - edge) {
        window.scrollBy({ top: 12, behavior: "auto" });
      }
    });

    const finishDrag = async (event, cancelled = false) => {
      if (!dragged || event.pointerId !== pointerId) return;

      dragged = false;
      isDragging = false;
      row.classList.remove("is-dragging");
      document.body.classList.remove("is-reordering");

      if (handle.hasPointerCapture(pointerId)) {
        handle.releasePointerCapture(pointerId);
      }

      if (cancelled) {
        renderSchedule(schedule);
        return;
      }

      const slotIds = Array.from(list.querySelectorAll(".schedule-row")).map(
        (item) => item.dataset.slotId
      );

      const slotMap = new Map(schedule.slots.map((slot) => [slot.id, slot]));
      schedule.slots = slotIds.map((id, index) => ({
        ...slotMap.get(id),
        position: index,
        time: TIME_LABELS[index]
      }));

      try {
        const updatedSchedule = await request("/api/schedule/reorder", {
          method: "PUT",
          body: JSON.stringify({ slotIds })
        });
        renderSchedule(updatedSchedule);
      } catch (error) {
        showToast(error.message, true);
        await reloadSchedule();
      } finally {
        if (pendingRemoteSchedule) {
          const remoteSchedule = pendingRemoteSchedule;
          pendingRemoteSchedule = null;
          renderSchedule(remoteSchedule);
        }
      }
    };

    handle.addEventListener("pointerup", (event) => finishDrag(event));
    handle.addEventListener("pointercancel", (event) => finishDrag(event, true));
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

      socket.on("connect", () => setConnectionState("online"));
      socket.on("disconnect", () => setConnectionState("offline"));
      socket.on("connect_error", () => setConnectionState("offline"));
      socket.on("schedule:update", renderSchedule);
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
