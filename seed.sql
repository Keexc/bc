-- Kenyan Excellence Awards — bulk seed data
-- Run this ONCE in the Supabase SQL editor, after schema.sql
-- Uses a DO block with variables so category ids can be reused for their nominees

do $$
declare
  cat_radio uuid;
  cat_vernacular_radio uuid;
  cat_kalenjin uuid;
  cat_rising_kalenjin uuid;
  cat_kamba uuid;
  cat_young_politician uuid;
  cat_hardworking_politician uuid;
begin

  -- ===== Entertainment =====

  insert into categories (name, section, display_order) values ('Best Radio Presenter', 'entertainment', 1) returning id into cat_radio;
  insert into nominees (category_id, full_name, organization) values
    (cat_radio, 'Isaac Waihenya', 'Radio Jambo / Gukena FM'),
    (cat_radio, 'Eva Mwalii', 'Radio 47'),
    (cat_radio, 'Mwanaisha Chidzuga', 'Radio 47'),
    (cat_radio, 'Anthony Ndiema', 'Radio Maisha'),
    (cat_radio, 'Christian Odanga', 'Alpha Radio'),
    (cat_radio, 'Judith Kiplagat', 'Chamgei FM');

  insert into categories (name, section, display_order) values ('Best Vernacular Radio Presenter', 'entertainment', 2) returning id into cat_vernacular_radio;
  insert into nominees (category_id, full_name, organization) values
    (cat_vernacular_radio, 'Newton Matia', 'Chamgei FM'),
    (cat_vernacular_radio, 'DJ Kipro', 'Chamgei FM'),
    (cat_vernacular_radio, 'Vivian Kurui', 'Berur FM'),
    (cat_vernacular_radio, 'Mike Lagat', 'Kass FM'),
    (cat_vernacular_radio, 'Samwel Towett', 'Kass FM'),
    (cat_vernacular_radio, 'Elijah Tuwei', 'Kass FM');

  insert into categories (name, section, display_order) values ('Best Kalenjin Artist', 'entertainment', 3) returning id into cat_kalenjin;
  insert into nominees (category_id, full_name) values
    (cat_kalenjin, 'Japhe Kay'),
    (cat_kalenjin, 'Hasira 44'),
    (cat_kalenjin, 'Methuselah'),
    (cat_kalenjin, 'Tobby Mr. Romantic');

  insert into categories (name, section, display_order) values ('Best Rising Kalenjin Artist', 'entertainment', 4) returning id into cat_rising_kalenjin;
  insert into nominees (category_id, full_name, organization) values
    (cat_rising_kalenjin, 'Rommy Classic', null),
    (cat_rising_kalenjin, 'Ravine Star', null),
    (cat_rising_kalenjin, 'Man Kibor', 'Tenges Finest'),
    (cat_rising_kalenjin, 'Shillah Nonii', null);

  insert into categories (name, section, display_order) values ('Best Kamba Artist', 'entertainment', 5) returning id into cat_kamba;
  insert into nominees (category_id, full_name) values
    (cat_kamba, 'Alex Kasau Katombi'),
    (cat_kamba, 'Stephen Kasolo'),
    (cat_kamba, 'Alphonce Kioko Maima'),
    (cat_kamba, 'Kakai Kilonzo');

  -- ===== Politics =====
  -- NOTE: left is_active = true by default (schema default). If you want to
  -- hold these back until you're comfortable with the consent question we
  -- discussed earlier, run:
  --   update categories set is_active = false where section = 'politics';

  insert into categories (name, section, display_order) values ('Best Young Politician', 'politics', 1) returning id into cat_young_politician;
  insert into nominees (category_id, full_name) values
    (cat_young_politician, 'Sen. Edwin Sifuna'),
    (cat_young_politician, 'MP Reuben Kiborek'),
    (cat_young_politician, 'Sen. John Methu'),
    (cat_young_politician, 'MP Oscar Kipchumba Sudi'),
    (cat_young_politician, 'MP Peter Salasya'),
    (cat_young_politician, 'MP John Paul Mwirigi');

  insert into categories (name, section, display_order) values ('Best Hardworking Politician', 'politics', 2) returning id into cat_hardworking_politician;
  insert into nominees (category_id, full_name) values
    (cat_hardworking_politician, 'William Samoei Ruto'),
    (cat_hardworking_politician, 'Kithure Kindiki'),
    (cat_hardworking_politician, 'Babu Owino');

end $$;
