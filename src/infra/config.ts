/** Read lazily so tests can override process.env before starting the app. */
export const config = {
  get port(): number {
    return Number(process.env.PORT ?? 3000);
  },
  get workersEnabled(): boolean {
    return (process.env.WORKERS_ENABLED ?? 'true') === 'true';
  },
  get sqs() {
    const endpoint = process.env.SQS_ENDPOINT ?? 'http://localhost:4566';
    const base = `${endpoint}/000000000000`;
    return {
      region: process.env.AWS_REGION ?? 'us-east-1',
      endpoint,
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
      queueUrl: process.env.SQS_QUEUE_URL ?? `${base}/wager-transactions.fifo`,
      dlqUrl: process.env.SQS_DLQ_URL ?? `${base}/wager-transactions-dlq.fifo`,
      eventsQueueUrl: process.env.SQS_EVENTS_QUEUE_URL ?? `${base}/wager-events.fifo`,
    };
  },
};
