import { createCachedProxyRoute } from "../lib/cachedProxyRoute.js";

export default createCachedProxyRoute({
  url: 'https://www.cusense.net:8082/api/v1/sensorData/realtime/all',
  fetchInit: {
    method: 'GET',
    headers: {
      'X-Gravitee-Api-Key': process.env.CUSENSE_API_KEY ?? '',
      'Accept': 'application/json',
    },
  },
  errorLabel: 'CU-Sense',
});
