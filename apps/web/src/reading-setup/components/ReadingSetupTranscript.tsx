/** Dispatches ordered view-model entries to presentation components without inferring workflow. */

import type { ReadingSetupCommands } from '../session/types';
import type { ReadingSetupTranscriptEntry } from '../transcript/types';
import { AssistantEntry } from './entries/AssistantEntry';
import { BriefEntry } from './entries/BriefEntry';
import { GenericToolEntry } from './entries/GenericToolEntry';
import { NoticeEntry } from './entries/NoticeEntry';
import { QuestionEntry } from './entries/QuestionEntry';
import { QueryActivityEntry } from './entries/QueryActivityEntry';
import { StrategyEntry } from './entries/StrategyEntry';
import { TrialEntry } from './entries/TrialEntry';
import { UserEntry } from './entries/UserEntry';

export function ReadingSetupTranscript({
  entries,
  commands,
  interactionsLocked = false,
}: {
  entries: ReadingSetupTranscriptEntry[];
  commands: ReadingSetupCommands;
  interactionsLocked?: boolean;
}) {
  return (
    <section className="rss-transcript" aria-label="读前准备内容">
      {entries.map((entry) => {
        switch (entry.kind) {
          case 'assistant':
            return <AssistantEntry key={entry.id} entry={entry} />;
          case 'user':
            return <UserEntry key={entry.id} entry={entry} />;
          case 'question':
            return (
              <QuestionEntry
                key={entry.id}
                entry={entry}
                commands={commands}
                interactionsLocked={interactionsLocked}
              />
            );
          case 'query':
            return <QueryActivityEntry key={entry.id} entry={entry} />;
          case 'profile':
            return null;
          case 'brief':
            return <BriefEntry key={entry.id} entry={entry} />;
          case 'strategy':
            return (
              <StrategyEntry
                key={entry.id}
                entry={entry}
                commands={commands}
                interactionsLocked={interactionsLocked}
              />
            );
          case 'trial':
            return (
              <TrialEntry
                key={entry.id}
                entry={entry}
                commands={commands}
                interactionsLocked={interactionsLocked}
              />
            );
          case 'tool':
            return <GenericToolEntry key={entry.id} entry={entry} />;
          case 'notice':
            return <NoticeEntry key={entry.id} entry={entry} commands={commands} />;
        }
      })}
    </section>
  );
}
