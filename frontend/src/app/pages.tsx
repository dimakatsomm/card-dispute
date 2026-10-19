import { useParams } from 'react-router';

const Placeholder = ({ title, detail }: { readonly title: string; readonly detail?: string | undefined }) => (
  <section>
    <h1>{title}</h1>
    {detail ? <p>{detail}</p> : null}
  </section>
);

export const HomePage = () => <Placeholder title="Your accounts" />;

export const AccountPage = () => {
  const { accountId } = useParams();
  return <Placeholder title="Account" detail={accountId} />;
};

export const CardPage = () => {
  const { cardId } = useParams();
  return <Placeholder title="Card" detail={cardId} />;
};

export const DisputeFormPage = () => {
  const { transactionId } = useParams();
  return <Placeholder title="Dispute a transaction" detail={transactionId} />;
};

export const DisputesListPage = () => <Placeholder title="Your disputes" />;

export const DisputeDetailPage = () => {
  const { transactionId } = useParams();
  return <Placeholder title="Dispute" detail={transactionId} />;
};

export const NotFoundPage = () => <Placeholder title="Page not found" />;
