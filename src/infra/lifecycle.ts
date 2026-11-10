/** Process-wide flag: once true, /health/ready answers 503 so the load balancer stops sending traffic. */
export const lifecycle = { shuttingDown: false };
