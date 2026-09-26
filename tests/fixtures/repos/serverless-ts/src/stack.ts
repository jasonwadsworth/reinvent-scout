// Synthetic CDK stack fixture -- exercises import-form CDK module detection.
import { Stack, StackProps } from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import { Construct } from "constructs";

export class ServerlessStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const table = new dynamodb.Table(this, "Orders", {
      partitionKey: { name: "id", type: dynamodb.AttributeType.STRING },
    });

    const fn = new lambda.Function(this, "Handler", {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "handler.handler",
      code: lambda.Code.fromAsset("src"),
    });
    table.grantReadData(fn);

    new apigateway.LambdaRestApi(this, "Api", { handler: fn });
  }
}
