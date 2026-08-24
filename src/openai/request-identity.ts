export type RequestIdentity = Readonly<{
  userId: string;
  chatId: string;
}>;

export type RequestIdentityResolver = (
  request: Request,
) => RequestIdentity | undefined;
