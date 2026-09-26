# Synthetic fixture -- exercises terraform aws_* resource detection.
provider "aws" {
  region = "us-east-1"
}

resource "aws_dynamodb_table" "orders" {
  name         = "orders"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "id"

  attribute {
    name = "id"
    type = "S"
  }
}

resource "aws_ecs_service" "worker" {
  name            = "worker"
  cluster         = "default"
  task_definition = "worker-task"
  desired_count   = 1
}
