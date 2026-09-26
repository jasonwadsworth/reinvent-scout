# Synthetic fixture -- exercises boto3.client and boto3.resource detection with both
# single- and double-quoted service names.
import boto3

dynamodb = boto3.resource('dynamodb')
s3 = boto3.client("s3")
sfn = boto3.client('stepfunctions')


def handler(event, context):
    table = dynamodb.Table('orders')
    table.get_item(Key={'id': event['id']})
    s3.get_object(Bucket='uploads', Key='x')
    sfn.start_execution(stateMachineArn='arn:aws:states:::x')
