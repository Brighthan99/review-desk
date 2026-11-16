/** A pull request named by the reviewer: which repository, which number. */
export interface PullRef {
  host: string;
  owner: string;
  repo: string;
  number: number;
}

/**
 * A pull request from its address, any tab of it (`https://github.com/o/r/pull/12/files`,
 * GitHub Enterprise hosts too), or written `o/r#12` (on github.com).
 */
export function parsePullUrl(text: string): PullRef | undefined {
  const t = text.trim();
  const url = /^(?:https?:\/\/)?([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/pulls?\/(\d+)(?:[/?#]\S*)?$/.exec(
    t,
  );
  if (url) {
    return {
      host: url[1].toLowerCase().replace(/^www\./, ''),
      owner: url[2],
      repo: url[3].replace(/\.git$/, ''),
      number: Number(url[4]),
    };
  }
  const short = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(t);
  if (short)
    return { host: 'github.com', owner: short[1], repo: short[2], number: Number(short[3]) };
  return undefined;
}
