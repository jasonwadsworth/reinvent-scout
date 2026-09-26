# Decoy inside terraform's local module cache -- a real walker must never descend into .terraform.
resource "aws_s3_bucket" "should_never_be_detected" {
  bucket = "should-never-be-detected"
}
