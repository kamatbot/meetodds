//! Free-talk content: the topic openers, closing line and fallbacks the tutor
//! uses outside a scripted scene, for every target language including Spanish.
//!
//! GENERATED FILE - do not hand-edit. Source of truth is
//! tools/scene-authoring/talk/<lang>.json; regenerate with
//! tools/scene-authoring/codegen_talk.py. See docs/SCENE-AUTHORING.md.
//!
//! The Spanish entry was extracted verbatim from the constants that used to
//! live in `crate::spanish::scenes`, so moving Spanish onto this registry is a
//! no-op for the learner. `spanish_parity` in the test module pins that.

/// Openers for one free-talk topic, indexed by the tutor's level dial.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Topic {
    pub id: &'static str,
    /// [dial][choice] - 3 dial bands, 3 interchangeable openers each.
    pub openers: [[&'static str; 3]; 3],
}

/// Everything the tutor says in a language when no scene is driving it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TalkContent {
    pub language_id: &'static str,
    /// Said once a scene is finished.
    pub closing: &'static str,
    /// Opens free talk when no topic is chosen.
    pub talk_fallback: &'static str,
    /// Used when a scene lookup fails, so the tutor still says something useful.
    pub scaffold_fallback: &'static str,
    /// Model-facing pacing instructions in English, indexed by dial 0..=3.
    pub dial_instructions: [&'static str; 4],
    pub topics: [Topic; 6],
}

impl TalkContent {
    pub fn topic(&self, id: &str) -> Option<&Topic> {
        self.topics.iter().find(|t| t.id == id)
    }
    /// Clamps rather than panicking on a dial from stored state.
    pub fn dial_instruction(&self, dial: u8) -> &'static str {
        self.dial_instructions[(dial as usize).min(3)]
    }
}

impl Topic {
    pub fn openers_for(&self, dial: u8) -> &[&'static str; 3] {
        &self.openers[(dial as usize).min(2)]
    }
}

/// Free-talk topic ids, shared across every language.
pub static TOPIC_IDS: [&str; 6] = ["family", "school", "sports", "food", "travel", "games"];


pub static NORWEGIAN_TALK: TalkContent = TalkContent {
    language_id: "nb",
    closing: "Kjempebra, da er vi ferdige! Vil du øve en gang til, eller snakke om noe annet?",
    talk_fallback: "Hva liker du å gjøre i fritida?",
    scaffold_fallback: "Vil du snakke om mat eller om spill?",
    dial_instructions: [
        "ONE short question only (max 10 words), present tense, one main clause, nothing before the question. Question word first with V2 word order (e.g. 'Hva liker du å gjøre i helgene?'); no subordinate clauses, no 'ville'/'skulle' forms.",
        "At most two short sentences with familiar everyday vocabulary; end with a question. Simple main clauses in V2 order, present tense or simple preteritum, du-forms only; avoid 'som'/'at' clauses.",
        "Natural sentences; invite reasons and past experiences: preteritum and perfektum ('har + partisipp'), 'fordi'/'siden' clauses, 'hvorfor' and 'hvordan' follow-ups on what the learner just said.",
        "Natural idiom and nuanced follow-up questions: conditional 'ville/skulle ha' and 'hvis du hadde…', comparisons ('heller enn', 'sammenlignet med'), sentence adverbs like 'jo', 'vel', 'nok', and relaxed everyday Eastern Norwegian speech.",
    ],
    topics: [
        Topic {
            id: "family",
            openers: [
                ["Hva liker du å gjøre med familien din?", "Hvem snakker du mest med hjemme?", "Hva gjør dere sammen i helgene?"],
                ["Hva gjorde du med familien din forrige helg?", "Hvilken familietradisjon liker du best?", "Hvordan har familien din forandret seg med tida?"],
                ["Hvilken tradisjon i familien ville du helst beholdt for alltid?", "Hvordan ville du løst en uenighet hjemme?", "Hva har du lært av noen i familien din?"],
            ],
        },
        Topic {
            id: "school",
            openers: [
                ["Hvilket fag liker du best?", "Hva gjør du i friminuttet?", "Hvordan er klassen din?"],
                ["Hva lærte du denne uka?", "Hva ville du forandret på timeplanen din?", "Hvordan forbereder du deg til et prosjekt?"],
                ["Hva gjør en time interessant?", "Hvordan ville du utformet drømmeskolen din?", "Er det viktigere å pugge eller å forstå?"],
            ],
        },
        Topic {
            id: "sports",
            openers: [
                ["Hvilken sport liker du?", "Liker du best å spille selv eller å se kamper?", "Hvor trener du?"],
                ["Når begynte du med den sporten?", "Hvordan var den siste kampen du så?", "Hvilken sport har du lyst til å prøve?"],
                ["Hva setter du mest pris på i et lag?", "Hva ville du forandret på reglene i favorittsporten din?", "Hvordan påvirker sport livet ditt?"],
            ],
        },
        Topic {
            id: "food",
            openers: [
                ["Hva er favorittmaten din?", "Hva spiser du vanligvis til frokost?", "Liker du best søtt eller salt?"],
                ["Hva lagde eller spiste du i går?", "Hvilken rett har du lyst til å lære å lage?", "Hvilken mat smakte du for første gang nylig?"],
                ["Hvilken rett sier mest om et sted du kjenner?", "Hvordan har smaken din forandret seg med årene?", "Hva gjør et måltid minneverdig?"],
            ],
        },
        Topic {
            id: "travel",
            openers: [
                ["Hvor har du lyst til å reise?", "Liker du best stranda eller fjellet?", "Hva har du i sekken din?"],
                ["Hvordan var den siste ferien din?", "Hvilket sted overrasket deg mest?", "Hvordan ville du planlagt en kort tur?"],
                ["Hva lærte du på reise som du ikke hadde ventet?", "Hvordan ville du valgt mellom komfort og eventyr?", "Hva gjør at du føler deg hjemme et annet sted?"],
            ],
        },
        Topic {
            id: "games",
            openers: [
                ["Hva er favorittspillet ditt?", "Hvem liker du å spille med?", "Liker du best brettspill eller dataspill?"],
                ["Hvordan lærte du å spille favorittspillet ditt?", "Hva skjedde sist du spilte?", "Hvilket spill ville du anbefalt til en venn?"],
                ["Hva gjør at et spill fortsetter å være interessant?", "Hvordan ville du laget et samarbeidsspill?", "Hva ville du forandret på favorittspillet ditt, og hvorfor?"],
            ],
        },
    ],
};

pub static SPANISH_TALK: TalkContent = TalkContent {
    language_id: "es",
    closing: "¡Muy bien, terminamos! ¿Quieres practicar otra vez o hablar de otro tema?",
    talk_fallback: "¿Qué te gusta hacer en tu tiempo libre?",
    scaffold_fallback: "¿Quieres hablar de comida o de juegos?",
    dial_instructions: [
        "UNA sola pregunta corta (máximo 10 palabras), en presente, una cláusula. Nada antes de la pregunta.",
        "Máximo dos frases cortas con vocabulario familiar; termina con una pregunta.",
        "Natural sentences; invite reasons and past experiences.",
        "Natural idioms and nuanced follow-up questions.",
    ],
    topics: [
        Topic {
            id: "family",
            openers: [
                ["¿Qué te gusta hacer con tu familia?", "¿Con quién hablas más en casa?", "¿Qué hacéis juntos los fines de semana?"],
                ["¿Qué hiciste con tu familia el fin de semana pasado?", "¿Qué tradición familiar te gusta más?", "¿Cómo ha cambiado tu familia con el tiempo?"],
                ["¿Qué costumbre familiar te gustaría conservar siempre?", "¿Cómo resolverías una diferencia de opinión en casa?", "¿Qué has aprendido de alguien de tu familia?"],
            ],
        },
        Topic {
            id: "school",
            openers: [
                ["¿Qué asignatura te gusta más?", "¿Qué haces durante el recreo?", "¿Cómo es tu clase?"],
                ["¿Qué aprendiste esta semana?", "¿Qué cambiarías de tu horario?", "¿Cómo te preparas para un proyecto?"],
                ["¿Qué hace que una clase sea interesante?", "¿Cómo diseñarías tu escuela ideal?", "¿Es más importante memorizar o comprender?"],
            ],
        },
        Topic {
            id: "sports",
            openers: [
                ["¿Qué deporte te gusta?", "¿Prefieres jugar o ver partidos?", "¿Dónde haces ejercicio?"],
                ["¿Cuándo empezaste a practicar ese deporte?", "¿Cómo fue el último partido que viste?", "¿Qué deporte te gustaría probar?"],
                ["¿Qué valoras más en un equipo?", "¿Qué cambiarías de las reglas de tu deporte favorito?", "¿Cómo influye el deporte en tu vida?"],
            ],
        },
        Topic {
            id: "food",
            openers: [
                ["¿Cuál es tu comida favorita?", "¿Qué desayunas normalmente?", "¿Prefieres dulce o salado?"],
                ["¿Qué cocinaste o comiste ayer?", "¿Qué plato te gustaría aprender a preparar?", "¿Qué comida probaste por primera vez recientemente?"],
                ["¿Qué plato representa mejor un lugar que conoces?", "¿Cómo han cambiado tus gustos con los años?", "¿Qué hace que una comida sea memorable?"],
            ],
        },
        Topic {
            id: "travel",
            openers: [
                ["¿Adónde quieres viajar?", "¿Prefieres la playa o la montaña?", "¿Qué llevas en tu mochila?"],
                ["¿Cómo fueron tus últimas vacaciones?", "¿Qué lugar te sorprendió más?", "¿Cómo prepararías un viaje corto?"],
                ["¿Qué aprendiste viajando que no esperabas?", "¿Cómo elegirías entre comodidad y aventura?", "¿Qué hace que te sientas en casa en otro lugar?"],
            ],
        },
        Topic {
            id: "games",
            openers: [
                ["¿Cuál es tu juego favorito?", "¿Con quién te gusta jugar?", "¿Prefieres juegos de mesa o videojuegos?"],
                ["¿Cómo aprendiste a jugar a tu juego favorito?", "¿Qué pasó en tu última partida?", "¿Qué juego recomendarías a un amigo?"],
                ["¿Qué hace que un juego siga siendo interesante?", "¿Cómo diseñarías un juego cooperativo?", "¿Qué cambiarías de tu juego favorito y por qué?"],
            ],
        },
    ],
};

pub static ENGLISH_TALK: TalkContent = TalkContent {
    language_id: "en",
    closing: "Great job, we're done! Do you want to practice again or talk about something else?",
    talk_fallback: "What do you like doing in your free time?",
    scaffold_fallback: "Do you want to talk about food or games?",
    dial_instructions: [
        "ONE short question only (max 10 words), present simple, a single clause. Nothing before the question.",
        "At most two short sentences using familiar, everyday vocabulary; end with a question.",
        "Natural sentences; invite reasons and past experiences, drawing on past simple and present perfect.",
        "Natural idioms, phrasal verbs and nuanced follow-up questions; conditionals and comparisons welcome.",
    ],
    topics: [
        Topic {
            id: "family",
            openers: [
                ["What do you like doing with your family?", "Who do you talk to most at home?", "What do you do together on weekends?"],
                ["What did you do with your family last weekend?", "Which family tradition do you like best?", "How has your family changed over time?"],
                ["Which family custom would you like to keep forever?", "How would you settle a difference of opinion at home?", "What have you learned from someone in your family?"],
            ],
        },
        Topic {
            id: "school",
            openers: [
                ["Which subject do you like best?", "What do you do during break?", "What's your class like?"],
                ["What did you learn this week?", "What would you change about your schedule?", "How do you get ready for a project?"],
                ["What makes a class interesting?", "How would you design your ideal school?", "Is it more important to memorize or to understand?"],
            ],
        },
        Topic {
            id: "sports",
            openers: [
                ["Which sport do you like?", "Do you prefer playing or watching games?", "Where do you exercise?"],
                ["When did you start playing that sport?", "How was the last game you watched?", "Which sport would you like to try?"],
                ["What do you value most in a team?", "What would you change about the rules of your favorite sport?", "How do sports shape your life?"],
            ],
        },
        Topic {
            id: "food",
            openers: [
                ["What's your favorite food?", "What do you usually have for breakfast?", "Do you prefer sweet or savory?"],
                ["What did you cook or eat yesterday?", "Which dish would you like to learn to make?", "What food have you tried for the first time recently?"],
                ["Which dish best represents a place you know?", "How have your tastes changed over the years?", "What makes a meal memorable?"],
            ],
        },
        Topic {
            id: "travel",
            openers: [
                ["Where do you want to travel?", "Do you prefer the beach or the mountains?", "What do you carry in your backpack?"],
                ["How was your last vacation?", "Which place surprised you the most?", "How would you plan a short trip?"],
                ["What did you learn while traveling that you didn't expect?", "How would you choose between comfort and adventure?", "What makes you feel at home somewhere else?"],
            ],
        },
        Topic {
            id: "games",
            openers: [
                ["What's your favorite game?", "Who do you like playing with?", "Do you prefer board games or video games?"],
                ["How did you learn to play your favorite game?", "What happened the last time you played?", "Which game would you recommend to a friend?"],
                ["What keeps a game interesting?", "How would you design a cooperative game?", "What would you change about your favorite game, and why?"],
            ],
        },
    ],
};

pub static FRENCH_TALK: TalkContent = TalkContent {
    language_id: "fr",
    closing: "Très bien, on s'arrête là ! Tu veux t'entraîner encore ou parler d'autre chose ?",
    talk_fallback: "Qu'est-ce que tu aimes faire pendant ton temps libre ?",
    scaffold_fallback: "Tu veux parler de cuisine ou de jeux ?",
    dial_instructions: [
        "ONE short question only (max 10 words), present tense, one clause. Use everyday spoken question forms (intonation or 'c'est quoi, ton… ?', 'tu aimes quoi ?'), never inversion. Nothing before the question.",
        "At most two short sentences with familiar vocabulary; passé composé and 'je vais + infinitive' are fine. End with a question in 'est-ce que' or intonation form, no inversion.",
        "Natural sentences; invite reasons ('pourquoi', 'parce que') and past experiences in passé composé and imparfait; use the conditional ('tu aimerais', 'tu ferais') to open hypotheticals.",
        "Natural idiom and everyday spoken French (dropped 'ne', 'on' for 'nous', connectors like 'du coup', 'en fait'); nuanced follow-ups using 'si + imparfait' hypotheticals, the subjunctive after 'bien que' / 'ce qui compte, c'est que', and comparisons ('plutôt que', 'par rapport à').",
    ],
    topics: [
        Topic {
            id: "family",
            openers: [
                ["Qu'est-ce que tu aimes faire avec ta famille ?", "Avec qui tu parles le plus à la maison ?", "Vous faites quoi ensemble le week-end ?"],
                ["Qu'est-ce que tu as fait avec ta famille le week-end dernier ?", "Quelle tradition familiale tu préfères ?", "Comment ta famille a changé avec le temps ?"],
                ["Quelle habitude familiale tu voudrais garder toute ta vie ?", "Comment tu réglerais un désaccord à la maison ?", "Qu'est-ce que tu as appris de quelqu'un de ta famille ?"],
            ],
        },
        Topic {
            id: "school",
            openers: [
                ["Quelle matière tu préfères ?", "Tu fais quoi pendant la récré ?", "Elle est comment, ta classe ?"],
                ["Qu'est-ce que tu as appris cette semaine ?", "Qu'est-ce que tu changerais dans ton emploi du temps ?", "Comment tu te prépares pour un projet ?"],
                ["Qu'est-ce qui rend un cours intéressant ?", "Comment tu imaginerais ton école idéale ?", "C'est plus important de mémoriser ou de comprendre ?"],
            ],
        },
        Topic {
            id: "sports",
            openers: [
                ["Quel sport tu aimes ?", "Tu préfères jouer ou regarder les matchs ?", "Où est-ce que tu fais du sport ?"],
                ["Quand est-ce que tu as commencé ce sport ?", "Il était comment, le dernier match que tu as vu ?", "Quel sport tu aimerais essayer ?"],
                ["Qu'est-ce que tu apprécies le plus dans une équipe ?", "Qu'est-ce que tu changerais aux règles de ton sport préféré ?", "Quelle place le sport prend dans ta vie ?"],
            ],
        },
        Topic {
            id: "food",
            openers: [
                ["C'est quoi, ton plat préféré ?", "Tu manges quoi au petit-déjeuner, d'habitude ?", "Tu préfères le sucré ou le salé ?"],
                ["Qu'est-ce que tu as cuisiné ou mangé hier ?", "Quel plat tu aimerais apprendre à préparer ?", "Quel plat tu as goûté pour la première fois récemment ?"],
                ["Quel plat représente le mieux un endroit que tu connais ?", "Comment tes goûts ont changé avec les années ?", "Qu'est-ce qui rend un repas mémorable ?"],
            ],
        },
        Topic {
            id: "travel",
            openers: [
                ["Où est-ce que tu veux voyager ?", "Tu préfères la plage ou la montagne ?", "Qu'est-ce que tu mets dans ton sac à dos ?"],
                ["Elles étaient comment, tes dernières vacances ?", "Quel endroit t'a le plus surpris ?", "Comment tu préparerais un petit voyage ?"],
                ["Qu'est-ce que tu as appris en voyageant, sans t'y attendre ?", "Comment tu choisirais entre confort et aventure ?", "Qu'est-ce qui fait que tu te sens chez toi ailleurs ?"],
            ],
        },
        Topic {
            id: "games",
            openers: [
                ["C'est quoi, ton jeu préféré ?", "Avec qui tu aimes jouer ?", "Tu préfères les jeux de société ou les jeux vidéo ?"],
                ["Comment tu as appris à jouer à ton jeu préféré ?", "Qu'est-ce qui s'est passé dans ta dernière partie ?", "Quel jeu tu conseillerais à un ami ?"],
                ["Qu'est-ce qui fait qu'un jeu reste intéressant ?", "Comment tu concevrais un jeu coopératif ?", "Qu'est-ce que tu changerais dans ton jeu préféré, et pourquoi ?"],
            ],
        },
    ],
};

pub static GERMAN_TALK: TalkContent = TalkContent {
    language_id: "de",
    closing: "Sehr gut, das war's! Willst du noch mal üben oder über ein anderes Thema reden?",
    talk_fallback: "Was machst du gern in deiner Freizeit?",
    scaffold_fallback: "Willst du über Essen oder über Spiele reden?",
    dial_instructions: [
        "ONE short question only (max 10 words), in the present tense (Präsens), a single main clause: either a W-question with the verb in second position or a yes/no question with the verb first. No subordinate clauses. Nothing before the question.",
        "At most two short sentences with familiar vocabulary; main clauses only (no dass/weil clauses), present tense or simple Perfekt with haben/sein; end with a question.",
        "Natural sentences; use the Perfekt and subordinate clauses with weil/dass/wenn; invite reasons and past experiences.",
        "Natural idioms, modal particles (doch, mal, eigentlich, denn), Konjunktiv II (würde/hätte/wäre) and nuanced follow-up questions.",
    ],
    topics: [
        Topic {
            id: "family",
            openers: [
                ["Was machst du gern mit deiner Familie?", "Mit wem redest du zu Hause am meisten?", "Was macht ihr am Wochenende zusammen?"],
                ["Was hast du letztes Wochenende mit deiner Familie gemacht?", "Welche Familientradition magst du am liebsten?", "Wie hat sich deine Familie mit der Zeit verändert?"],
                ["Welche Familiengewohnheit würdest du gern für immer behalten?", "Wie würdest du eine Meinungsverschiedenheit zu Hause lösen?", "Was hast du von jemandem aus deiner Familie gelernt?"],
            ],
        },
        Topic {
            id: "school",
            openers: [
                ["Welches Fach magst du am liebsten?", "Was machst du in der Pause?", "Wie ist deine Klasse?"],
                ["Was hast du diese Woche gelernt?", "Was würdest du an deinem Stundenplan ändern?", "Wie bereitest du dich auf ein Projekt vor?"],
                ["Was macht eine Unterrichtsstunde interessant?", "Wie würdest du deine ideale Schule gestalten?", "Was ist wichtiger: auswendig lernen oder verstehen?"],
            ],
        },
        Topic {
            id: "sports",
            openers: [
                ["Welchen Sport magst du?", "Spielst du lieber selbst oder schaust du lieber zu?", "Wo machst du Sport?"],
                ["Wann hast du mit diesem Sport angefangen?", "Wie war das letzte Spiel, das du gesehen hast?", "Welchen Sport würdest du gern mal ausprobieren?"],
                ["Was ist dir in einem Team am wichtigsten?", "Was würdest du an den Regeln deines Lieblingssports ändern?", "Wie beeinflusst Sport dein Leben?"],
            ],
        },
        Topic {
            id: "food",
            openers: [
                ["Was ist dein Lieblingsessen?", "Was frühstückst du normalerweise?", "Isst du lieber süß oder salzig?"],
                ["Was hast du gestern gekocht oder gegessen?", "Welches Gericht würdest du gern kochen lernen?", "Was hast du in letzter Zeit zum ersten Mal probiert?"],
                ["Welches Gericht steht am besten für einen Ort, den du kennst?", "Wie hat sich dein Geschmack über die Jahre verändert?", "Was macht ein Essen unvergesslich?"],
            ],
        },
        Topic {
            id: "travel",
            openers: [
                ["Wohin möchtest du reisen?", "Magst du lieber Strand oder Berge?", "Was hast du in deinem Rucksack?"],
                ["Wie war dein letzter Urlaub?", "Welcher Ort hat dich am meisten überrascht?", "Wie würdest du eine kurze Reise planen?"],
                ["Was hast du auf Reisen gelernt, womit du nicht gerechnet hast?", "Wie würdest du dich zwischen Komfort und Abenteuer entscheiden?", "Was gibt dir an einem anderen Ort das Gefühl, zu Hause zu sein?"],
            ],
        },
        Topic {
            id: "games",
            openers: [
                ["Was ist dein Lieblingsspiel?", "Mit wem spielst du gern?", "Magst du lieber Brettspiele oder Videospiele?"],
                ["Wie hast du dein Lieblingsspiel gelernt?", "Was ist in deiner letzten Runde passiert?", "Welches Spiel würdest du einem Freund empfehlen?"],
                ["Was macht ein Spiel auf Dauer interessant?", "Wie würdest du ein kooperatives Spiel gestalten?", "Was würdest du an deinem Lieblingsspiel ändern, und warum?"],
            ],
        },
    ],
};

pub static ITALIAN_TALK: TalkContent = TalkContent {
    language_id: "it",
    closing: "Benissimo, abbiamo finito! Vuoi esercitarti ancora o parlare di un altro argomento?",
    talk_fallback: "Cosa ti piace fare nel tempo libero?",
    scaffold_fallback: "Vuoi parlare di cibo o di giochi?",
    dial_instructions: [
        "ONE short question only (max 10 words), in the presente indicativo, one clause, using tu. Nothing before the question.",
        "At most two short sentences with familiar vocabulary (presente, simple passato prossimo); end with a question, using tu.",
        "Natural sentences; invite reasons (perché) and past experiences (passato prossimo, imperfetto). Keep tu throughout.",
        "Natural Italian idiom, congiuntivo and condizionale where they come naturally, and nuanced follow-up questions. Keep tu throughout.",
    ],
    topics: [
        Topic {
            id: "family",
            openers: [
                ["Cosa ti piace fare con la tua famiglia?", "Con chi parli di più a casa?", "Cosa fate insieme nel fine settimana?"],
                ["Cosa hai fatto con la tua famiglia lo scorso fine settimana?", "Quale tradizione di famiglia ti piace di più?", "Com'è cambiata la tua famiglia nel tempo?"],
                ["Quale abitudine di famiglia vorresti conservare per sempre?", "Come risolveresti una differenza di opinioni in casa?", "Cosa hai imparato da qualcuno della tua famiglia?"],
            ],
        },
        Topic {
            id: "school",
            openers: [
                ["Quale materia ti piace di più?", "Cosa fai durante la ricreazione?", "Com'è la tua classe?"],
                ["Cosa hai imparato questa settimana?", "Cosa cambieresti del tuo orario?", "Come ti prepari per un progetto?"],
                ["Cosa rende interessante una lezione?", "Come progetteresti la tua scuola ideale?", "È più importante memorizzare o capire?"],
            ],
        },
        Topic {
            id: "sports",
            openers: [
                ["Quale sport ti piace?", "Preferisci giocare o guardare le partite?", "Dove fai sport?"],
                ["Quando hai iniziato a praticare questo sport?", "Com'è stata l'ultima partita che hai visto?", "Quale sport ti piacerebbe provare?"],
                ["Cosa apprezzi di più in una squadra?", "Cosa cambieresti delle regole del tuo sport preferito?", "Come influisce lo sport sulla tua vita?"],
            ],
        },
        Topic {
            id: "food",
            openers: [
                ["Qual è il tuo piatto preferito?", "Cosa mangi di solito a colazione?", "Preferisci il dolce o il salato?"],
                ["Cosa hai cucinato o mangiato ieri?", "Quale piatto ti piacerebbe imparare a preparare?", "Quale cibo hai provato per la prima volta di recente?"],
                ["Quale piatto rappresenta meglio un posto che conosci?", "Come sono cambiati i tuoi gusti con gli anni?", "Cosa rende memorabile un pasto?"],
            ],
        },
        Topic {
            id: "travel",
            openers: [
                ["Dove vuoi andare in viaggio?", "Preferisci il mare o la montagna?", "Cosa porti nello zaino?"],
                ["Come sono andate le tue ultime vacanze?", "Quale posto ti ha sorpreso di più?", "Come organizzeresti un viaggio breve?"],
                ["Cosa hai imparato viaggiando che non ti aspettavi?", "Come sceglieresti tra comodità e avventura?", "Cosa ti fa sentire a casa in un altro posto?"],
            ],
        },
        Topic {
            id: "games",
            openers: [
                ["Qual è il tuo gioco preferito?", "Con chi ti piace giocare?", "Preferisci i giochi da tavolo o i videogiochi?"],
                ["Come hai imparato a giocare al tuo gioco preferito?", "Cos'è successo nella tua ultima partita?", "Quale gioco consiglieresti a un amico?"],
                ["Cosa fa sì che un gioco resti interessante nel tempo?", "Come progetteresti un gioco cooperativo?", "Cosa cambieresti del tuo gioco preferito e perché?"],
            ],
        },
    ],
};

pub static PORTUGUESE_TALK: TalkContent = TalkContent {
    language_id: "pt",
    closing: "Muito bem, terminamos! Quer praticar de novo ou falar de outro assunto?",
    talk_fallback: "O que você gosta de fazer no seu tempo livre?",
    scaffold_fallback: "Quer falar de comida ou de jogos?",
    dial_instructions: [
        "ONE short question only (max 10 words), present tense, one clause, addressed with você. Nothing before the question.",
        "At most two short sentences with familiar vocabulary (present tense or simple pretérito perfeito; 'a gente' is fine); end with a question.",
        "Natural Brazilian sentences; invite reasons and past experiences (pretérito perfeito and imperfeito, 'por quê?', 'como foi?').",
        "Natural Brazilian idiom and nuanced follow-up questions; use hypotheticals and the conditional (futuro do pretérito, 'e se…?', 'o que você faria?').",
    ],
    topics: [
        Topic {
            id: "family",
            openers: [
                ["O que você gosta de fazer com a sua família?", "Com quem você mais conversa em casa?", "O que vocês fazem juntos no fim de semana?"],
                ["O que você fez com a sua família no fim de semana passado?", "Qual tradição da sua família você mais gosta?", "Como a sua família mudou com o tempo?"],
                ["Que costume da sua família você gostaria de manter para sempre?", "Como você resolveria uma diferença de opinião em casa?", "O que você aprendeu com alguém da sua família?"],
            ],
        },
        Topic {
            id: "school",
            openers: [
                ["Qual matéria você mais gosta?", "O que você faz no recreio?", "Como é a sua turma?"],
                ["O que você aprendeu esta semana?", "O que você mudaria no seu horário?", "Como você se prepara para um trabalho da escola?"],
                ["O que faz uma aula ser interessante?", "Como você montaria a sua escola ideal?", "É mais importante decorar ou entender?"],
            ],
        },
        Topic {
            id: "sports",
            openers: [
                ["Que esporte você gosta?", "Você prefere jogar ou assistir aos jogos?", "Onde você faz exercício?"],
                ["Quando você começou a praticar esse esporte?", "Como foi o último jogo que você assistiu?", "Que esporte você gostaria de experimentar?"],
                ["O que você mais valoriza em um time?", "O que você mudaria nas regras do seu esporte favorito?", "Como o esporte influencia a sua vida?"],
            ],
        },
        Topic {
            id: "food",
            openers: [
                ["Qual é a sua comida favorita?", "O que você costuma comer no café da manhã?", "Você prefere doce ou salgado?"],
                ["O que você cozinhou ou comeu ontem?", "Que prato você gostaria de aprender a fazer?", "Que comida você experimentou pela primeira vez recentemente?"],
                ["Que prato representa melhor um lugar que você conhece?", "Como o seu gosto mudou com os anos?", "O que faz uma refeição ser memorável?"],
            ],
        },
        Topic {
            id: "travel",
            openers: [
                ["Para onde você quer viajar?", "Você prefere praia ou montanha?", "O que você leva na sua mochila?"],
                ["Como foram as suas últimas férias?", "Que lugar mais te surpreendeu?", "Como você prepararia uma viagem curta?"],
                ["O que você aprendeu viajando que não esperava?", "Como você escolheria entre conforto e aventura?", "O que faz você se sentir em casa em outro lugar?"],
            ],
        },
        Topic {
            id: "games",
            openers: [
                ["Qual é o seu jogo favorito?", "Com quem você gosta de jogar?", "Você prefere jogo de tabuleiro ou videogame?"],
                ["Como você aprendeu a jogar o seu jogo favorito?", "O que aconteceu na sua última partida?", "Que jogo você recomendaria para um amigo?"],
                ["O que faz um jogo continuar interessante?", "Como você criaria um jogo cooperativo?", "O que você mudaria no seu jogo favorito e por quê?"],
            ],
        },
    ],
};

pub static MANDARIN_TALK: TalkContent = TalkContent {
    language_id: "zh",
    closing: "太好了，我们结束了！你想再练一次，还是换个话题聊聊？",
    talk_fallback: "你有空的时候喜欢做什么？",
    scaffold_fallback: "你想聊吃的还是聊游戏？",
    dial_instructions: [
        "ONE short question only (at most 12 characters), one clause, no aspect markers (no 了, 过, 着) and no time adverbs; use a simple 吗 question or a 什么/哪/谁/哪儿 question. Nothing before the question.",
        "At most two short sentences with familiar, basic vocabulary (simple 是/有/喜欢/想 sentences, 还是 choices); end with a question.",
        "Natural sentences; invite reasons (为什么, 因为……所以……) and past experiences (了, 过, ……的时候), with 比 and 还是 comparisons.",
        "Natural colloquial Mandarin with idioms, 成语 and sentence-final particles (吧, 呢, 嘛); nuanced follow-up questions using hypotheticals (如果……的话, 要是……) and 比起……, 相比之下 comparisons.",
    ],
    topics: [
        Topic {
            id: "family",
            openers: [
                ["你喜欢和家人一起做什么？", "在家里你和谁说话最多？", "周末你们一家人一起做什么？"],
                ["上个周末你和家人做了什么？", "你最喜欢家里的哪个传统？", "这些年你的家庭有什么变化？"],
                ["你希望家里的哪个习惯一直保留下去？", "如果家里人意见不一样，你会怎么解决？", "你从家里的某个人身上学到了什么？"],
            ],
        },
        Topic {
            id: "school",
            openers: [
                ["你最喜欢哪门课？", "课间休息的时候你做什么？", "你们班是什么样的？"],
                ["这个星期你学到了什么？", "你想改一改课程表的哪一部分？", "你是怎么准备一个项目的？"],
                ["什么样的课才算有意思？", "如果让你设计理想的学校，你会怎么设计？", "你觉得记忆更重要，还是理解更重要？"],
            ],
        },
        Topic {
            id: "sports",
            openers: [
                ["你喜欢什么运动？", "你喜欢自己打球，还是看比赛？", "你在哪儿锻炼？"],
                ["你是什么时候开始做这项运动的？", "你最近看的一场比赛怎么样？", "你想试试什么新运动？"],
                ["在一个团队里，你最看重什么？", "你想改一改你最喜欢的运动的哪条规则？", "运动对你的生活有什么影响？"],
            ],
        },
        Topic {
            id: "food",
            openers: [
                ["你最喜欢吃什么？", "你早餐一般吃什么？", "你喜欢吃甜的还是咸的？"],
                ["你昨天做了什么菜，或者吃了什么？", "你想学做哪道菜？", "你最近第一次尝了什么新东西？"],
                ["哪道菜最能代表你熟悉的一个地方？", "这些年你的口味有什么变化？", "什么样的一顿饭会让人难忘？"],
            ],
        },
        Topic {
            id: "travel",
            openers: [
                ["你想去哪儿旅行？", "你喜欢海边还是山里？", "你的背包里装什么？"],
                ["你上次的假期过得怎么样？", "哪个地方最让你意外？", "你会怎么安排一次短途旅行？"],
                ["旅行中你学到了什么意想不到的东西？", "舒适和冒险，你会怎么选？", "什么会让你在别的地方也有家的感觉？"],
            ],
        },
        Topic {
            id: "games",
            openers: [
                ["你最喜欢的游戏是什么？", "你喜欢和谁一起玩？", "你喜欢桌游还是电子游戏？"],
                ["你是怎么学会玩你最喜欢的游戏的？", "你上一局玩得怎么样？", "你会向朋友推荐什么游戏？"],
                ["是什么让一个游戏一直有意思？", "如果让你设计一款合作游戏，你会怎么设计？", "你想改一改你最喜欢的游戏的什么地方，为什么？"],
            ],
        },
    ],
};

/// Free-talk content for a language id, or `None` if it is not a known id.
pub fn talk_for(language_id: &str) -> Option<&'static TalkContent> {
    match language_id {
        "nb" => Some(&NORWEGIAN_TALK),
        "es" => Some(&SPANISH_TALK),
        "en" => Some(&ENGLISH_TALK),
        "fr" => Some(&FRENCH_TALK),
        "de" => Some(&GERMAN_TALK),
        "it" => Some(&ITALIAN_TALK),
        "pt" => Some(&PORTUGUESE_TALK),
        "zh" => Some(&MANDARIN_TALK),
        _ => None,
    }
}

/// Every language this module carries free-talk content for.
pub static TALK_LANGUAGES: [&str; 8] = ["nb", "es", "en", "fr", "de", "it", "pt", "zh"];


#[cfg(test)]
mod tests {
    use super::*;

    fn all() -> Vec<&'static TalkContent> {
        TALK_LANGUAGES
            .iter()
            .map(|id| talk_for(id).expect("registered language has talk content"))
            .collect()
    }

    #[test]
    fn every_language_is_complete() {
        assert_eq!(TALK_LANGUAGES.len(), 8);
        for t in all() {
            assert!(!t.closing.trim().is_empty(), "{}", t.language_id);
            assert!(!t.talk_fallback.trim().is_empty(), "{}", t.language_id);
            assert!(!t.scaffold_fallback.trim().is_empty(), "{}", t.language_id);
            for d in t.dial_instructions.iter() {
                assert!(!d.trim().is_empty(), "{}", t.language_id);
            }
            assert_eq!(t.topics.len(), 6, "{}", t.language_id);
        }
    }

    #[test]
    fn topics_share_ids_and_order_across_languages() {
        for t in all() {
            for (topic, want) in t.topics.iter().zip(TOPIC_IDS.iter()) {
                assert_eq!(&topic.id, want, "{} topic order", t.language_id);
            }
        }
    }

    #[test]
    fn every_opener_is_a_question() {
        for t in all() {
            for text in [t.closing, t.talk_fallback, t.scaffold_fallback] {
                assert!(
                    text.ends_with('?') || text.ends_with('\u{ff1f}'),
                    "{}: {text}", t.language_id
                );
            }
            for topic in t.topics.iter() {
                for row in topic.openers.iter() {
                    for o in row.iter() {
                        assert!(
                            o.ends_with('?') || o.ends_with('\u{ff1f}'),
                            "{}/{}: {o}", t.language_id, topic.id
                        );
                    }
                }
            }
        }
    }

    /// Moving Spanish onto this registry must be invisible to the learner:
    /// these are the exact strings the Spanish engine used before.
    #[test]
    fn spanish_parity() {
        let es = talk_for("es").expect("spanish present");
        assert_eq!(
            es.closing,
            "¡Muy bien, terminamos! ¿Quieres practicar otra vez o hablar de otro tema?"
        );
        assert_eq!(es.talk_fallback, "¿Qué te gusta hacer en tu tiempo libre?");
        assert_eq!(es.scaffold_fallback, "¿Quieres hablar de comida o de juegos?");
        assert_eq!(
            es.dial_instruction(0),
            "UNA sola pregunta corta (máximo 10 palabras), en presente, una cláusula. Nada antes de la pregunta."
        );
        assert_eq!(
            es.dial_instruction(2),
            "Natural sentences; invite reasons and past experiences."
        );
        let family = es.topic("family").expect("family topic");
        assert_eq!(family.openers[0][0], "¿Qué te gusta hacer con tu familia?");
        assert_eq!(
            family.openers[2][2],
            "¿Qué has aprendido de alguien de tu familia?"
        );
    }

    #[test]
    fn dial_and_opener_lookups_clamp() {
        let t = talk_for("de").expect("german present");
        assert_eq!(t.dial_instruction(9), t.dial_instruction(3));
        let topic = t.topic("food").expect("food topic");
        assert_eq!(topic.openers_for(9), topic.openers_for(2));
        assert!(t.topic("nonexistent").is_none());
    }

    #[test]
    fn unknown_language_is_not_served() {
        assert!(talk_for("xx").is_none());
        assert!(talk_for("").is_none());
    }

    #[test]
    fn languages_do_not_share_openers() {
        let sets = all();
        for (i, a) in sets.iter().enumerate() {
            for b in sets.iter().skip(i + 1) {
                assert_ne!(
                    a.talk_fallback, b.talk_fallback,
                    "{} and {} share a fallback", a.language_id, b.language_id
                );
            }
        }
    }

    #[test]
    fn mandarin_carries_no_pinyin_in_learner_text() {
        let zh = talk_for("zh").expect("mandarin present");
        let mut texts = vec![zh.closing, zh.talk_fallback, zh.scaffold_fallback];
        for topic in zh.topics.iter() {
            for row in topic.openers.iter() {
                texts.extend(row.iter().copied());
            }
        }
        for text in texts {
            assert!(
                !text.chars().any(|c| c.is_ascii_alphabetic()),
                "Mandarin learner text has Latin letters: {text}"
            );
        }
    }

    /// Pacing instructions are model-facing and written in English, even for
    /// Mandarin, where they may still cite structures in characters.
    #[test]
    fn dial_instructions_are_english_prose() {
        for t in all() {
            for d in t.dial_instructions.iter() {
                let latin = d.chars().filter(|c| c.is_ascii_alphabetic()).count();
                assert!(latin >= 20, "{} dial instruction not English: {d}", t.language_id);
            }
        }
    }
}
