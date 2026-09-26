// Synthetic fixture -- exercises Go SDK v2 service import detection.
package main

import (
	"context"

	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
)

func main() {
	ctx := context.Background()
	cfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		panic(err)
	}

	ddb := dynamodb.NewFromConfig(cfg)
	queue := sqs.NewFromConfig(cfg)

	_ = ddb
	_ = queue
}
