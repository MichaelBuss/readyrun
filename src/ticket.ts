export type Ticket = {
  id: string;
  title: string;
  body: string;
  url: string;
  labels: string[];
  blockedBy: string[];
  parent?: string;
};
