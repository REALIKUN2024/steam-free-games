export type GameKind = "game" | "demo";

export type Game = {
  id: number;
  name: string;
  image: string;
  release: string;
  rating: number | null;
  win: boolean;
  mac: boolean;
  linux: boolean;
  kind: GameKind;
  genres?: string[];
};

export type GameListPayload = {
  updatedAt: string;
  source: string;
  count: number;
  games: Game[];
};

export type MetaPayload = {
  updatedAt: string;
  source: string;
  games: number;
  demos: number;
  gameChunks: number;
  demoChunks: number;
};
