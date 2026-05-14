import { createCachedProxyRoute } from "../lib/cachedProxyRoute.js";

export default createCachedProxyRoute({
  url: 'https://api.airgradient.com/public/api/v1/world/locations/measures/current',
  errorLabel: 'AirGradient',
});
