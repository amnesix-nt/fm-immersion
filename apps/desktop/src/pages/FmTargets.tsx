import { roleCeiling,
  engineValue,
  POS_LABEL,
  buildProject,
  clubFinances,
  financeState,
  projectCompat,
  rankTargets,
  storedTargets,
  type FmPlayer,
  type FmSnapshot,
  type StoredTarget,
  type TargetVerdict,
} from "@fm-immersion/module-fm";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { PosBadge } from './FmFoot';
import { fmData } from "../lib/data";
import { useFmSaveScope, writeScoped } from "../lib/save-store";
import { FmDbSearch } from "./FmDbSearch";
import { useTacticEngine } from "./FmTactic";
import { FmTacticRecruits } from "./FmTacticRecruits";
import {
  CompatTag,
  EngineTag,
  Empty,
  Fit,
  Level,
  More,
  Panel,
  Tag,
  useCoach,
  useFormat,
  useNames,
  type Tone,
} from "./FmUi";

type Filter = "list" | "all" | "dismissed";

/** Âge à partir duquel une recrue ne vaut qu'à court terme. */
const OLD_TARGET = 33;
const VERDICT_TONE: Record<TargetVerdict, Tone> = {
  starter: "good",
  backup: "info",
  none: "warn",
};

/**
 * Cibles du mercato : joueurs suivis dans le jeu (liste de suivi, cibles du recrutement), gardés dans la base
 * de FM Immersion et classés selon ce que chacun apporte au onze cible du projet.
 */
export function FmTargets({
  saveId,
  snap,
  players,
  folder,
  go,
}: {
  saveId: string;
  snap: FmSnapshot;
  players: FmPlayer[];
  folder: string;
  go: (view: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const scope = useFmSaveScope();
  const names = useNames();
  const f = useFormat();
  const qc = useQueryClient();
  const { engine } = useTacticEngine(folder, players);
  const [coach] = useCoach();
  const [filter, setFilter] = useState<Filter>("list");
  const own = useMemo(
    () => players.filter((p) => !p.injury && Object.keys(p.attributes).length),
    [players],
  );
  // Finances serrées : une cible au-dessus du budget de transfert est marquée « hors budget » (libre ou prêt sinon).
  const budgetCap = useMemo(() => {
    const fin = clubFinances(snap, players);
    return financeState(fin).tight && fin.transferBudget != null ? fin.transferBudget : null;
  }, [snap, players]);
  const pr = useMemo(
    () => buildProject(engine, own, coach),
    [engine, own, coach],
  );

  // La base est remplie à chaque import d'instantané : on la relit quand l'instantané change.
  const { data: rows } = useQuery({
    queryKey: ["fm", saveId, "targets", snap.gameDate],
    queryFn: () => fmData.targets(saveId),
  });
  const all = useMemo(() => storedTargets(rows ?? [], players), [rows, players]);
  const shown = useMemo(
    () =>
      all.filter((p) =>
        filter === "dismissed"
          ? p.dismissed
          : !p.dismissed && (filter === "all" || p.inList),
      ),
    [all, filter],
  );
  const ranked = useMemo(() => {
    const withAttrs = shown.filter((p) => Object.keys(p.attributes).length);
    const rest = shown
      .filter((p) => !Object.keys(p.attributes).length)
      .map((target) => ({ target, best: null }));
    return [
      ...(pr
        ? rankTargets(engine, withAttrs, pr, players)
        : withAttrs.map((target) => ({ target, best: null }))),
      ...rest,
    ] as {
      target: StoredTarget;
      best: ReturnType<typeof rankTargets>[number]["best"];
    }[];
  }, [engine, shown, pr, players]);

  const dismiss = useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) =>
      fmData.dismissTarget(saveId, id, on),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["fm", saveId, "targets"] }),
  });

  if (!pr) return <Empty>{t("fm.tac.noAttributes")}</Empty>;
  const read = (snap as { collecte?: Record<string, string> }).collecte?.cibles;

  // Le jeu met -1 ou 0 quand il ne connaît pas la valeur.
  const money = (v: number | null | undefined) =>
    v != null && v > 0 ? f.money(v) : "–";

  const compare = (id: string) => {
    writeScoped("fmi.compare", scope, [id]);
    go("compare");
  };

  const counts = {
    list: all.filter((p) => p.inList && !p.dismissed).length,
    all: all.filter((p) => !p.dismissed).length,
    dismissed: all.filter((p) => p.dismissed).length,
  };

  const followed = new Set(
    all
      .filter((p) => p.inList && !p.dismissed)
      .map((p) => p.id.replace(/^t/, "")),
  );

  return (
    <>
      <FmTacticRecruits
        saveId={saveId}
        gameDate={snap.gameDate}
        snap={snap}
        engine={engine}
        project={pr}
        players={players}
        followedTargets={all.filter((p) => !p.dismissed && Object.keys(p.attributes).length)}
      />
      <Panel
        title={t("fm.targets.title", {
          style: names.style(pr.style),
          form: pr.form,
        })}
        action={
          all.length ? (
            <div className="flex gap-1 text-xs">
              {(["list", "all", "dismissed"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setFilter(k)}
                  className={`chip ${filter === k ? 'chip-on' : ''}`}
                >
                  {t(`fm.targets.filter.${k}`, { n: counts[k] })}
                </button>
              ))}
            </div>
          ) : undefined
        }
      >
        <More>{t("fm.targets.help")}</More>
        {ranked.length ? (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead className="text-left text-canard/70">
                <tr>
                  {[
                    "player",
                    "age",
                    "club",
                    "pos",
                    "fit",
                    "meta",
                    "gain",
                    "level",
                    "stars",
                    "knowledge",
                    "value",
                    "seen",
                    "",
                  ].map((k) => (
                    <th key={k} className="px-2 py-1">
                      {k && t(`fm.targets.col.${k}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ranked.map(({ target: p, best }) => {
                  const pid = p.id.replace(/^t/, "");
                  const value = p.scout?.value;
                  return (
                    <tr
                      key={p.id}
                      className={`border-t border-canard/5 hover:bg-creme/60 ${p.inList && best?.verdict !== "none" ? "" : "text-canard/60"}`}
                    >
                      <td
                        className="cursor-pointer px-2 py-1.5 font-bold"
                        onClick={() => compare(p.id)}
                        title={t("fm.targets.compare")}
                      >
                        {p.name}
                        {p.scout?.recommendation && (
                          <div className="text-xs font-normal text-brun">
                            {p.scout.recommendation}
                          </div>
                        )}
                      </td>
                      <td className="px-2 py-1.5 tabular-nums">
                        {p.age ?? "–"}
                      </td>
                      <td className="px-2 py-1.5">
                        {p.sources.includes("essai") ? (
                          <Tag tone="info">{t("fm.targets.trial")}</Tag>
                        ) : (
                          (p.club ?? "–")
                        )}
                      </td>
                      <td className="px-2 py-1.5">
                        {best ? (
                          <>
                            <PosBadge pos={best.slot.pos} />{" "}
                            {names.role(engine.roles.get(best.slot.ip))}
                          </>
                        ) : (
                          <span className="text-xs text-brun">
                            {Object.keys(p.attributes).length
                              ? t("fm.targets.outside")
                              : t("fm.targets.unknown")}
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-1.5">
                        <Fit value={best?.fit} />
                      </td>
                      <td className="px-2 py-1.5">
                        {best && best.slot.pos !== "GB" ? <EngineTag v={engineValue(p, best.slot.pos)} /> : "–"}
                      </td>
                      <td
                        className="px-2 py-1.5"
                        title={
                          best
                            ? t("fm.targets.gainHelp", {
                                gain: `${best.gain > 0 ? "+" : ""}${best.gain.toLocaleString(i18n.resolvedLanguage, { maximumFractionDigits: 1 })}`,
                              })
                            : undefined
                        }
                      >
                        {best ? (
                          <>
                            <Tag tone={VERDICT_TONE[best.verdict]}>
                              {t(`fm.targets.verdict.${best.verdict}`)}
                            </Tag>{" "}
                            {/* Profil du projet : utile seulement pour une cible qui apporte quelque chose. */}
                            {pr && best.verdict !== "none" && <CompatTag c={projectCompat(engine, pr, p)} />}
                            {best.verdict !== "none" && p.age != null && p.age >= OLD_TARGET && (
                              <Tag tone="warn">{t("fm.targets.shortTerm")}</Tag>
                            )}
                            {best.over && (
                              <div className="mt-0.5 text-xs text-brun">
                                {t(`fm.targets.over.${best.verdict}`, {
                                  name: best.over.name,
                                })}
                              </div>
                            )}
                          </>
                        ) : (
                          "–"
                        )}
                      </td>
                      <td className="px-2 py-1.5">
                        <Level value={p.level} />
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-xs tabular-nums">
                        {p.level != null
                          ? (roleCeiling(p.level, p) ?? p.level).toLocaleString(i18n.resolvedLanguage, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
                          : "–"}
                      </td>
                      <td
                        className="px-2 py-1.5 tabular-nums"
                        title={p.scout?.knowledgeText ?? undefined}
                      >
                        {p.scout?.knowledge != null
                          ? `${Math.round(p.scout.knowledge)} %`
                          : "–"}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 tabular-nums">
                        {value?.min != null &&
                        value.max != null &&
                        value.min !== value.max
                          ? `${f.money(value.min)} – ${f.money(value.max)}`
                          : money(value?.mid ?? p.value)}
                        {budgetCap != null && (value?.min ?? value?.mid ?? p.value ?? 0) > budgetCap && (
                          <Tag tone="warn">{t("fm.tight.overBudget")}</Tag>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-xs">
                        {p.inList ? (
                          <Tag tone="good">{t("fm.targets.inList")}</Tag>
                        ) : (
                          t("fm.targets.lastSeen", { date: f.date(p.lastSeen) })
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        <button
                          type="button"
                          className="text-xs font-bold text-orange-fonce hover:underline"
                          onClick={() =>
                            dismiss.mutate({ id: pid, on: !p.dismissed })
                          }
                        >
                          {p.dismissed
                            ? t("fm.targets.restore")
                            : t("fm.targets.dismiss")}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <>
            <Empty>
              {all.length
                ? t("fm.targets.emptyFilter")
                : read && !read.startsWith("désactivée")
                  ? t("fm.targets.noneRead", { status: read })
                  : t("fm.targets.none")}
            </Empty>
            <button
              type="button"
              className="mt-3 text-sm font-bold text-orange-fonce hover:underline"
              onClick={() => go("project")}
            >
              {t("fm.targets.toProject")} →
            </button>
          </>
        )}
      </Panel>
      <FmDbSearch
        saveId={saveId}
        gameDate={snap.gameDate}
        engine={engine}
        project={pr}
        players={players}
        followed={followed}
      />
    </>
  );
}
