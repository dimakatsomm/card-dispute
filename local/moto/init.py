import os

import boto3
from botocore.exceptions import ClientError

endpoint = os.environ["AWS_ENDPOINT_URL"]
region = os.environ["AWS_DEFAULT_REGION"]
buckets = os.environ["MOTO_BUCKETS"].split(",")
queue = os.environ["MOTO_QUEUE"]
dlq = f"{queue}-dlq"
max_receive_count = os.environ["MOTO_MAX_RECEIVE_COUNT"]

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
queue_url = sqs.create_queue(QueueName=queue, Attributes={"RedrivePolicy": redrive})["QueueUrl"]
print(f"queue ready: {queue_url} (dlq: {dlq_url})")
