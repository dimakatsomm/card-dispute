import os

import boto3
from botocore.exceptions import ClientError

endpoint = os.environ["AWS_ENDPOINT_URL"]
region = os.environ["AWS_DEFAULT_REGION"]
buckets = os.environ["MOTO_BUCKETS"].split(",")
queue = os.environ["MOTO_QUEUE"]
dlq = f"{queue}-dlq"
intake_dlq = os.environ.get("MOTO_INTAKE_DLQ", "evidence-intake-dlq")
max_receive_count = os.environ["MOTO_MAX_RECEIVE_COUNT"]
visibility_timeout = os.environ.get("MOTO_VISIBILITY_TIMEOUT", "5")

s3 = boto3.client("s3", endpoint_url=endpoint, region_name=region)
sqs = boto3.client("sqs", endpoint_url=endpoint, region_name=region)

for bucket in buckets:
    try:
        s3.create_bucket(Bucket=bucket, CreateBucketConfiguration={"LocationConstraint": region})
    except ClientError as e:
        # Re-running against a warm moto must not fail.
        if e.response["Error"]["Code"] not in ("BucketAlreadyOwnedByYou", "BucketAlreadyExists"):
            raise
    print(f"bucket ready: {bucket}")

dlq_url = sqs.create_queue(QueueName=dlq)["QueueUrl"]
dlq_arn = sqs.get_queue_attributes(QueueUrl=dlq_url, AttributeNames=["QueueArn"])["Attributes"]["QueueArn"]
redrive = f'{{"deadLetterTargetArn":"{dlq_arn}","maxReceiveCount":"{max_receive_count}"}}'
# Set after create so a warm moto (queue already exists) picks up changed values. Short visibility so a failed
# batch reaches the DLQ within an e2e wait.
queue_url = sqs.create_queue(QueueName=queue)["QueueUrl"]
sqs.set_queue_attributes(
    QueueUrl=queue_url,
    Attributes={"RedrivePolicy": redrive, "VisibilityTimeout": visibility_timeout},
)
print(f"queue ready: {queue_url} (dlq: {dlq_url}, visibility {visibility_timeout}s)")

intake_dlq_url = sqs.create_queue(QueueName=intake_dlq)["QueueUrl"]
print(f"queue ready: {intake_dlq_url}")
