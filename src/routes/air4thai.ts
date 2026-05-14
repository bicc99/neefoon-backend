import { createCachedProxyRoute } from "../lib/cachedProxyRoute.js";

export default createCachedProxyRoute({
  url: 'http://air4thai.pcd.go.th/services/getNewAQI_JSON.php',
  errorLabel: 'Air4Thai',
});
