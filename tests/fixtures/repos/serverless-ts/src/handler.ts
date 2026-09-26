// Synthetic Lambda handler fixture -- exercises AWS SDK client usage for the sdk-usage detector.
import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

const ddb = new DynamoDBClient({});
const s3 = new S3Client({});

export async function handler(event: { orderId: string }): Promise<void> {
  await ddb.send(new GetItemCommand({ TableName: "orders", Key: { id: { S: event.orderId } } }));
  await s3.send(new GetObjectCommand({ Bucket: "uploads", Key: event.orderId }));
}
