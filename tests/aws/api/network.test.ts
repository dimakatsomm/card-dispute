import {
  CreateNetworkInsightsPathCommand,
  DeleteNetworkInsightsAnalysisCommand,
  DeleteNetworkInsightsPathCommand,
  DescribeNetworkInsightsAnalysesCommand,
  DescribeNetworkInterfacesCommand,
  DescribeSecurityGroupsCommand,
  StartNetworkInsightsAnalysisCommand,
  type NetworkInsightsAnalysis,
} from '@aws-sdk/client-ec2';
import { describe, expect, it } from 'vitest';
import { ec2 } from '../src/aws.ts';
import { env } from '../src/env.ts';
import { until } from '../src/poll.ts';
import { probeExitCode, startProbe } from '../src/probe-task.ts';

const TASK_WAIT_MS = 10 * 60_000;
const ANALYSIS_WAIT_MS = 10 * 60_000;

// The e2e role may only delete insights resources carrying this tag.
const tagFor = (type: 'network-insights-path' | 'network-insights-analysis') => [
  { ResourceType: type, Tags: [{ Key: 'created-by', Value: `${env().namePrefix}-gha-e2e` }] },
];

const serviceEni = async (service: string): Promise<string> => {
  const groups = await ec2().send(
    new DescribeSecurityGroupsCommand({
      Filters: [{ Name: 'group-name', Values: [`${env().namePrefix}-${service}`] }],
    }),
  );
  const groupId = groups.SecurityGroups?.[0]?.GroupId;
  if (groupId === undefined) throw new Error(`security group ${env().namePrefix}-${service} not found`);
  const enis = await ec2().send(
    new DescribeNetworkInterfacesCommand({
      Filters: [
        { Name: 'group-id', Values: [groupId] },
        { Name: 'status', Values: ['in-use'] },
      ],
    }),
  );
  const eniId = enis.NetworkInterfaces?.[0]?.NetworkInterfaceId;
  if (eniId === undefined) throw new Error(`no running ${service} task to analyse (is desired_count 0?)`);
  return eniId;
};

describe('net-probe task (ADR-067)', () => {
  it(
    'from the dispute-notifier security group the service port answers and the token decides (401/403 as specified)',
    async () => {
      const run = await startProbe(env().notifierSgId, ['probe']);
      const task = await run.stopped(TASK_WAIT_MS);
      expect(probeExitCode(task), `${task.stoppedReason ?? 'no stop reason'}`).toBe(0);
    },
    TASK_WAIT_MS + 60_000,
  );

  // Reachability Analyzer needs a live source ENI, which for dev-tools exists only while a task runs.
  it(
    'from the dev-tools security group every service port is unreachable: the probe task and Reachability Analyzer agree',
    async () => {
      const run = await startProbe(env().toolsSgId, ['probe', '--expect-unreachable', '--hold', '420']);
      const source = await until('the net-probe ENI to be attached', () => run.eniId(), 3 * 60_000, 2_000);

      type Created = { pathId: string; analysisId: string; label: string };
      const created: Created[] = [];
      try {
        const targets = [
          ...(['users', 'disputes'] as const).flatMap((service) =>
            ([8080, 8081] as const).map((port) => ({ service, port })),
          ),
        ];
        const destinations = new Map(
          await Promise.all(
            [...new Set(targets.map((t) => t.service))].map(async (s) => [s, await serviceEni(s)] as const),
          ),
        );
        for (const { service, port } of targets) {
          const path = await ec2().send(
            new CreateNetworkInsightsPathCommand({
              Source: source,
              Destination: destinations.get(service) ?? '',
              Protocol: 'tcp',
              DestinationPort: port,
              TagSpecifications: tagFor('network-insights-path'),
            }),
          );
          const entry: Created = {
            pathId: path.NetworkInsightsPath?.NetworkInsightsPathId ?? '',
            analysisId: '',
            label: `${service}:${port}`,
          };
          created.push(entry);
          const analysis = await ec2().send(
            new StartNetworkInsightsAnalysisCommand({
              NetworkInsightsPathId: entry.pathId,
              TagSpecifications: tagFor('network-insights-analysis'),
            }),
          );
          entry.analysisId = analysis.NetworkInsightsAnalysis?.NetworkInsightsAnalysisId ?? '';
        }

        const done = await until(
          'Reachability Analyzer analyses to finish',
          async () => {
            const out = await ec2().send(
              new DescribeNetworkInsightsAnalysesCommand({
                NetworkInsightsAnalysisIds: created.map((c) => c.analysisId),
              }),
            );
            const analyses = out.NetworkInsightsAnalyses ?? [];
            return analyses.length === created.length && analyses.every((a) => a.Status !== 'running')
              ? analyses
              : undefined;
          },
          ANALYSIS_WAIT_MS,
          10_000,
        );
        const byId = new Map<string, NetworkInsightsAnalysis>(
          done.map((a) => [a.NetworkInsightsAnalysisId ?? '', a]),
        );
        for (const { analysisId, label } of created) {
          const analysis = byId.get(analysisId);
          expect(analysis?.Status, `${label}: ${analysis?.StatusMessage ?? ''}`).toBe('succeeded');
          expect(analysis?.NetworkPathFound, `dev-tools SG must have no path to ${label}`).toBe(false);
        }
      } finally {
        const leftovers: string[] = [];
        for (const { pathId, analysisId } of created) {
          if (analysisId !== '') {
            await ec2()
              .send(new DeleteNetworkInsightsAnalysisCommand({ NetworkInsightsAnalysisId: analysisId }))
              .catch(() => leftovers.push(analysisId));
          }
          if (pathId !== '') {
            await ec2()
              .send(new DeleteNetworkInsightsPathCommand({ NetworkInsightsPathId: pathId }))
              .catch(() => leftovers.push(pathId));
          }
        }
        if (leftovers.length > 0) console.info(`Reachability cleanup failed for: ${leftovers.join(', ')}`);
      }

      const task = await run.stopped(TASK_WAIT_MS);
      expect(probeExitCode(task), `${task.stoppedReason ?? 'no stop reason'}`).toBe(0);
    },
    ANALYSIS_WAIT_MS + TASK_WAIT_MS + 5 * 60_000,
  );
});
