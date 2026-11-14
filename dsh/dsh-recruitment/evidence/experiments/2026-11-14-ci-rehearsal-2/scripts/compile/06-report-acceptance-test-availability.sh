# local rendering of: if [ "${{ vars.CORPUS_AVAILABLE }}" = "true" ]
if [ "$CORPUS_AVAILABLE" = "true" ]; then
  echo "corpus acceptance job will run"
else
  echo "::notice title=Corpus acceptance NOT RUN::converter/tests needs the corpus originals (not in the repo, by design). Set repository variable CORPUS_AVAILABLE=true and provide the originals to run it. A green compile job is NOT acceptance evidence — see converter/reports/acceptance.md for the recorded run."
fi