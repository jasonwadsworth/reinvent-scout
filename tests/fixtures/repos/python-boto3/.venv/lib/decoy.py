# Decoy inside a virtualenv directory -- a real walker must never descend into .venv.
import boto3

client = boto3.client("this-should-never-be-detected")
