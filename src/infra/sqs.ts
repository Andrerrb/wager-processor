import { SQSClient } from '@aws-sdk/client-sqs';
import { config } from './config';

export function createSqsClient(): SQSClient {
  const { region, endpoint, accessKeyId, secretAccessKey } = config.sqs;
  return new SQSClient({ region, endpoint, credentials: { accessKeyId, secretAccessKey } });
}
