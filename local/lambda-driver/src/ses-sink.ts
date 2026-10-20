import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';

type SentEmail = {
  readonly messageId: string;
  readonly from: string | undefined;
  readonly to: readonly string[];
  readonly subject: string;
  readonly text: string | undefined;
  readonly html: string | undefined;
};

const content = z.object({ Data: z.string() });

const sendSchema = z.object({
  FromEmailAddress: z.string().optional(),
  Destination: z.object({
    ToAddresses: z.array(z.string()).default([]),
    CcAddresses: z.array(z.string()).default([]),
    BccAddresses: z.array(z.string()).default([]),
  }),
  Content: z.object({
    Simple: z.object({
      Subject: content,
      Body: z.object({ Text: content.optional(), Html: content.optional() }),
    }),
  }),
});

export const buildSesSink = (verified: readonly string[] | undefined): FastifyInstance => {
  const sent: SentEmail[] = [];
  const app = Fastify();

  app.post('/v2/email/outbound-emails', async (request, reply) => {
    const parsed = sendSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .header('x-amzn-errortype', 'BadRequestException')
        .send({ message: 'Unsupported or malformed SendEmail request' });
    }
    const { Destination, FromEmailAddress, Content } = parsed.data;
    const recipients = [...Destination.ToAddresses, ...Destination.CcAddresses, ...Destination.BccAddresses];
    const unverified = verified
      ? recipients.filter((address) => !verified.includes(address.toLowerCase()))
      : [];
    if (unverified.length > 0) {
      return reply
        .code(400)
        .header('x-amzn-errortype', 'MessageRejected')
        .send({
          message: `Email address is not verified. The following identities failed the check: ${unverified.join(', ')}`,
        });
    }
    const messageId = randomUUID();
    sent.push({
      messageId,
      from: FromEmailAddress,
      to: recipients,
      subject: Content.Simple.Subject.Data,
      text: Content.Simple.Body.Text?.Data,
      html: Content.Simple.Body.Html?.Data,
    });
    return { MessageId: messageId };
  });

  app.get('/sent', async () => sent);
  app.delete('/sent', async (_request, reply) => {
    sent.length = 0;
    return reply.code(204).send();
  });

  return app;
};
