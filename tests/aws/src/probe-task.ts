import { DescribeTasksCommand, RunTaskCommand, type Task } from '@aws-sdk/client-ecs';
import { ecs } from './aws.ts';
import { env } from './env.ts';
import { until } from './poll.ts';

export type ProbeRun = {
  readonly taskArn: string;
  readonly eniId: () => Promise<string | undefined>;
  readonly stopped: (timeoutMs: number) => Promise<Task>;
};

const cluster = (): string => `${env().namePrefix}-cluster`;

const describe = async (taskArn: string): Promise<Task | undefined> =>
  (await ecs().send(new DescribeTasksCommand({ cluster: cluster(), tasks: [taskArn] }))).tasks?.[0];

// No tags: the e2e role has no ecs:TagResource.
export const startProbe = async (securityGroupId: string, command: readonly string[]): Promise<ProbeRun> => {
  const out = await ecs().send(
    new RunTaskCommand({
      cluster: cluster(),
      taskDefinition: `${env().namePrefix}-net-probe`,
      launchType: 'FARGATE',
      count: 1,
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: [...env().toolsSubnetIds],
          securityGroups: [securityGroupId],
          assignPublicIp: 'DISABLED',
        },
      },
      overrides: { containerOverrides: [{ name: 'net-probe', command: [...command] }] },
    }),
  );
  const taskArn = out.tasks?.[0]?.taskArn;
  if (taskArn === undefined)
    throw new Error(`net-probe did not start: ${JSON.stringify(out.failures ?? [])}`);
  return {
    taskArn,
    eniId: async () =>
      (await describe(taskArn))?.attachments
        ?.flatMap((attachment) => attachment.details ?? [])
        .find((detail) => detail.name === 'networkInterfaceId')?.value,
    stopped: (timeoutMs) =>
      until(
        `net-probe task ${taskArn.split('/').pop()} to stop`,
        async () => {
          const task = await describe(taskArn);
          return task?.lastStatus === 'STOPPED' ? task : undefined;
        },
        timeoutMs,
        5_000,
      ),
  };
};

export const probeExitCode = (task: Task): number | undefined =>
  task.containers?.find((c) => c.name === 'net-probe')?.exitCode;
