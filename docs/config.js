(() => {
  "use strict";

  const RAILWAY_API_URL = "https://YOUR-RAILWAY-SERVICE.up.railway.app";
  const hostname = window.location.hostname;
  const isBackendHost =
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname.endsWith(".up.railway.app");

  window.SCHEDULE_APP_CONFIG = {
    apiBaseUrl: isBackendHost ? window.location.origin : RAILWAY_API_URL
  };
})();
